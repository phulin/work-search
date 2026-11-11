import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  mkdtemp,
  open,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { tokenize, type Document } from "../query/tokenize.js";
import {
  encodePostings,
  crc32,
  encoder,
  type Posting,
} from "../format/codec.js";
import {
  buildBinary,
  HEADER,
  TERM,
  LOCAL,
  VERSION,
  type Entry,
} from "../format/index.js";
import { encodeDocuments } from "../format/documents.js";
import { selectPostings } from "./selection.js";
export interface BuildOptions {
  input: string;
  out: string;
  budget?: number;
  strategy?: "smallest" | "workload";
  workload?: string[];
  chunkDocs?: number;
  objectBytes?: number;
}
export async function* lines(path: string) {
  for await (const line of createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  }))
    yield line;
}
async function write(
  stream: ReturnType<typeof createWriteStream>,
  data: string | Uint8Array,
) {
  if (!stream.write(data)) await once(stream, "drain");
}
async function finish(stream: ReturnType<typeof createWriteStream>) {
  stream.end();
  await once(stream, "finish");
}
class Merger {
  heap: {
    value: [string, Posting[]];
    iterator: AsyncIterator<string>;
    run: number;
  }[] = [];
  less(a: (typeof this.heap)[number], b: (typeof this.heap)[number]) {
    return (
      a.value[0] < b.value[0] || (a.value[0] === b.value[0] && a.run < b.run)
    );
  }
  push(x: (typeof this.heap)[number]) {
    const h = this.heap;
    h.push(x);
    let i = h.length - 1;
    while (i) {
      const p = (i - 1) >>> 1;
      if (!this.less(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }
  pop() {
    const h = this.heap,
      x = h[0],
      last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      while (i * 2 + 1 < h.length) {
        let c = i * 2 + 1;
        if (c + 1 < h.length && this.less(h[c + 1], h[c])) c++;
        if (!this.less(h[c], h[i])) break;
        [h[c], h[i]] = [h[i], h[c]];
        i = c;
      }
    }
    return x;
  }
  async init(paths: string[]) {
    for (let run = 0; run < paths.length; run++) {
      const iterator = lines(paths[run])[Symbol.asyncIterator](),
        v = await iterator.next();
      if (!v.done) this.push({ value: JSON.parse(v.value), iterator, run });
    }
  }
  async next() {
    if (!this.heap.length) return;
    const x = this.pop(),
      value = x.value,
      v = await x.iterator.next();
    if (!v.done) {
      x.value = JSON.parse(v.value);
      this.push(x);
    }
    return value;
  }
}
export async function build(options: BuildOptions) {
  const started = performance.now(),
    budget = options.budget ?? 8 * 1024 * 1024,
    strategy = options.strategy ?? "smallest",
    chunkDocs = options.chunkDocs ?? 5000,
    objectBytes = options.objectBytes ?? 64 * 1024 * 1024;
  if (
    !Number.isSafeInteger(budget) ||
    budget < 0 ||
    budget > 48 * 1024 * 1024 ||
    !Number.isInteger(chunkDocs) ||
    chunkDocs < 1 ||
    objectBytes < 1
  )
    throw new Error("Invalid build options");
  const temp = await mkdtemp(join(tmpdir(), "worker-search-")),
    db = new DatabaseSync(join(temp, "ids.sqlite"));
  db.exec(
    "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE ids (id TEXT PRIMARY KEY) WITHOUT ROWID; BEGIN",
  );
  const insert = db.prepare("INSERT INTO ids VALUES (?)");
  try {
    const hash = createHash("sha256").update(
      JSON.stringify({
        version: VERSION,
        budget,
        strategy,
        workload: options.workload ?? [],
        objectBytes,
      }),
    );
    const documents: {
        id: string;
        body: number;
        title: number;
        metaObject: number;
        metaOffset: number;
        metaLength: number;
      }[] = [],
      runs: string[] = [];
    let chunk = new Map<string, Posting[]>(),
      bodySum = 0,
      titleSum = 0,
      lineNo = 0,
      metaObj = 0,
      metaOffset = 0;
    const metaFiles = [join(temp, "metadata-0.bin")];
    let meta = createWriteStream(metaFiles[0]);
    const spill = async () => {
      if (!chunk.size) return;
      const path = join(temp, `run-${runs.length}.jsonl`),
        stream = createWriteStream(path);
      for (const term of [...chunk.keys()].sort())
        await write(stream, JSON.stringify([term, chunk.get(term)]) + "\n");
      await finish(stream);
      runs.push(path);
      chunk = new Map();
    };
    for await (const line of lines(options.input)) {
      lineNo++;
      if (!line.trim()) continue;
      let d: Document;
      try {
        d = JSON.parse(line);
      } catch {
        throw new Error(`Malformed JSON at line ${lineNo}`);
      }
      if (
        !d ||
        typeof d.id !== "string" ||
        !d.id ||
        typeof d.body !== "string" ||
        (d.title !== undefined && typeof d.title !== "string")
      )
        throw new Error(`Invalid document at line ${lineNo}`);
      try {
        insert.run(d.id);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("UNIQUE constraint failed")
        )
          throw error;
        throw new Error(`Duplicate document ID at line ${lineNo}: ${d.id}`);
      }
      hash.update(JSON.stringify(d) + "\n");
      const body = tokenize(d.body),
        title = tokenize(d.title ?? ""),
        doc = documents.length;
      if (doc >= 0xffffffff) throw new Error("Too many documents");
      const frequencies = new Map<string, Posting>();
      for (const [field, tokens] of [
        ["body", body],
        ["title", title],
      ] as const)
        for (const [position, term] of tokens.entries()) {
          let p = frequencies.get(term);
          if (!p) {
            p = {
              doc,
              body: 0,
              title: 0,
              bodyPositions: [],
              titlePositions: [],
            };
            frequencies.set(term, p);
          }
          p[field]++;
          p[field === "body" ? "bodyPositions" : "titlePositions"]!.push(
            position,
          );
        }
      for (const [term, p] of frequencies) {
        const list = chunk.get(term);
        if (list) list.push(p);
        else chunk.set(term, [p]);
      }
      const m = encoder.encode(
        JSON.stringify({ id: d.id, title: d.title, metadata: d.metadata }),
      );
      if (metaOffset && metaOffset + m.length > objectBytes) {
        await finish(meta);
        metaFiles.push(join(temp, `metadata-${++metaObj}.bin`));
        meta = createWriteStream(metaFiles[metaObj]);
        metaOffset = 0;
      }
      await write(meta, m);
      documents.push({
        id: d.id,
        body: body.length,
        title: title.length,
        metaObject: metaObj,
        metaOffset,
        metaLength: m.length,
      });
      metaOffset += m.length;
      bodySum += body.length;
      titleSum += title.length;
      if (documents.length % chunkDocs === 0) await spill();
    }
    await finish(meta);
    await spill();
    // Merge at most 32 open runs at a time, including intermediate passes.
    let active = runs,
      pass = 0;
    while (active.length > 32) {
      const next: string[] = [];
      for (let base = 0; base < active.length; base += 32) {
        const paths = active.slice(base, base + 32),
          m = new Merger();
        await m.init(paths);
        const dest = join(temp, `merge-${pass}-${base}`),
          s = createWriteStream(dest);
        let x;
        while ((x = await m.next())) await write(s, JSON.stringify(x) + "\n");
        await finish(s);
        next.push(dest);
        for (const p of paths) await rm(p);
      }
      active = next;
      pass++;
    }
    const merger = new Merger();
    await merger.init(active);
    const spoolPath = join(temp, "postings"),
      spool = createWriteStream(spoolPath),
      entries: (Entry & { spool: number })[] = [];
    let spoolOffset = 0,
      current: string | undefined,
      list: Posting[] = [];
    const emit = async () => {
      if (current === undefined) return;
      const bytes = encodePostings(list);
      entries.push({
        term: current,
        df: list.length,
        object: 0,
        offset: 0,
        length: bytes.length,
        crc: crc32(bytes),
        spool: spoolOffset,
      });
      await write(spool, bytes);
      spoolOffset += bytes.length;
    };
    let record;
    while ((record = await merger.next())) {
      if (record[0] !== current) {
        await emit();
        current = record[0];
        list = [];
      }
      for (const p of record[1]) list.push(p);
    }
    await emit();
    await finish(spool);
    const compressedDocuments = encodeDocuments(documents);
    const baseBytes =
      HEADER +
      entries.length * TERM +
      entries.reduce((s, e) => s + encoder.encode(e.term).length, 0) +
      compressedDocuments.length;
    if (baseBytes > budget)
      throw new Error(
        `Required dictionary/doc tables ${baseBytes} bytes exceed bundle budget ${budget}`,
      );
    const chosen = selectPostings(
        entries,
        budget - baseBytes,
        strategy,
        options.workload,
      ),
      generation = hash.digest("hex");
    await mkdir(options.out, { recursive: true });
    await mkdir(join(options.out, "objects"), { recursive: true });
    const objectRoot = join(options.out, "objects", generation);
    try {
      await mkdir(objectRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new Error(
        "Generation already exists; choose a fresh output directory",
      );
    }
    const input = await open(spoolPath, "r"),
      embedded: Uint8Array[] = [],
      objects: { key: string; size: number; sha256: string; kind: string }[] =
        [];
    let localOffset = 0,
      object = 0,
      offset = 0;
    let remote = createWriteStream(join(objectRoot, "postings-0.bin"));
    for (const e of entries) {
      const bytes = new Uint8Array(e.length);
      await input.read(bytes, 0, e.length, e.spool);
      if (chosen.has(e.term)) {
        e.object = LOCAL;
        e.offset = localOffset;
        localOffset += e.length;
        embedded.push(bytes);
      } else {
        if (offset && offset + e.length > objectBytes) {
          await finish(remote);
          object++;
          offset = 0;
          remote = createWriteStream(
            join(objectRoot, `postings-${object}.bin`),
          );
        }
        e.object = object;
        e.offset = offset;
        offset += e.length;
        await write(remote, bytes);
      }
    }
    await finish(remote);
    await input.close();
    for (let i = 0; i < metaFiles.length; i++)
      await writeFile(
        join(objectRoot, `metadata-${i}.bin`),
        await readFile(metaFiles[i]),
      );
    for (const [kind, n] of [
      ["postings", object + 1],
      ["metadata", metaFiles.length],
    ] as const)
      for (let i = 0; i < n; i++) {
        const name = `${kind}-${i}.bin`,
          bytes = await readFile(join(objectRoot, name));
        objects.push({
          key: `${generation}/${name}`,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          kind,
        });
      }
    const binary = buildBinary(
      generation,
      entries,
      compressedDocuments,
      documents.length,
      embedded,
      documents.length ? bodySum / documents.length : 0,
      documents.length ? titleSum / documents.length : 0,
    );
    await writeFile(join(options.out, "bundle.bin"), binary);
    const manifest = {
      format: VERSION,
      generation,
      documents: documents.length,
      terms: entries.length,
      budget,
      strategy,
      bundleBytes: binary.length,
      dictionaryBytes:
        HEADER +
        entries.length * TERM +
        entries.reduce((s, e) => s + encoder.encode(e.term).length, 0),
      documentTableBytes:
        baseBytes -
        HEADER -
        entries.length * TERM -
        entries.reduce((s, e) => s + encoder.encode(e.term).length, 0),
      documentTableUncompressedBytes:
        documents.length * 24 +
        documents.reduce((s, d) => s + encoder.encode(d.id).length, 0),
      postingsBytes: spoolOffset,
      embeddedBytes: localOffset,
      embeddedTerms: chosen.size,
      objects,
      bundleSha256: createHash("sha256").update(binary).digest("hex"),
    };
    await writeFile(
      join(options.out, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    return {
      ...manifest,
      buildMs: performance.now() - started,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    };
  } finally {
    db.close();
    await rm(temp, { recursive: true, force: true });
  }
}
