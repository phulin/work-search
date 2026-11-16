import {
  open,
  mkdir,
  readFile,
  writeFile,
  readdir,
  stat,
  unlink,
  rename,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { NumericDocument } from "../src/columnar/construction/analyzed-document.js";
import {
  SUFFIX_ROW_BYTES as ROW,
  SUFFIX_BLOCK_ROWS as BLOCK,
  PREFIX_WORDS,
  documentSuffixRows,
  compareSuffix,
  prefix,
  quantizer,
  type FixedScores,
  type SuffixBlock,
  type SuffixColumn,
  type SuffixManifest,
} from "../src/suffix/format.js";
import { encodeSuffixKeys } from "../src/suffix/keys.js";

const CHUNK = Math.floor((4 * 1048576) / ROW) * ROW;
class Sink {
  private buffer = Buffer.allocUnsafe(CHUNK);
  private used = 0;
  bytes = 0;
  constructor(readonly handle: Awaited<ReturnType<typeof open>>) {}
  push(row: Buffer, at: number) {
    row.copy(this.buffer, this.used, at, at + ROW);
    this.used += ROW;
    return this.used === this.buffer.length;
  }
  async flush() {
    if (!this.used) return;
    await this.handle.write(this.buffer, 0, this.used);
    this.bytes += this.used;
    this.used = 0;
  }
  async close() {
    await this.flush();
    await this.handle.close();
  }
}
async function* rowChunks(path: string) {
  const handle = await open(path, "r");
  try {
    const bytes = (await handle.stat()).size;
    if (bytes % ROW) throw Error("Truncated suffix construction rows");
    for (let at = 0; at < bytes; at += CHUNK) {
      const raw = Buffer.allocUnsafe(Math.min(CHUNK, bytes - at));
      const r = await handle.read(raw, 0, raw.length, at);
      if (r.bytesRead !== raw.length) throw Error("Truncated suffix rows");
      yield raw;
    }
  } finally {
    await handle.close();
  }
}
async function hashFile(path: string) {
  const h = createHash("sha256");
  for await (const b of createReadStream(path)) h.update(b);
  return h.digest("hex");
}

/** Offline experiment. All occurrence rows are retained; recursive lexical
 * partitioning limits each comparison sort to a fixed amount of row memory. */
export async function buildSuffixIndex(
  documents: AsyncIterable<NumericDocument>,
  stats: FixedScores,
  output: string,
  corpusGeneration: string,
  analysis?: string,
  sortMiB = 128,
) {
  await mkdir(output + "/staging", { recursive: true });
  if (!stats.idf)
    stats = {
      ...stats,
      idf: Float64Array.from(stats.df, (df) =>
        df ? Math.log(1 + (stats.count - df + 0.5) / (df + 0.5)) : 0,
      ),
    };
  const started = Date.now(),
    rootPath = output + "/extracted.json";
  let extracted = await readFile(rootPath, "utf8").then(
    JSON.parse,
    () => undefined,
  );
  if (extracted && extracted.corpusGeneration !== corpusGeneration)
    throw Error("Different suffix corpus");
  if (!extracted) {
    const tokenFile = await open(output + "/tokens", "w"),
      sinks = new Map<number, Sink>();
    let offset = 0,
      rows = 0,
      next = 0;
    try {
      for await (const document of documents) {
        if (document.doc !== next++)
          throw Error("Suffix corpus document coverage gap");
        const raw = Buffer.from(
          documentSuffixRows(document, offset, stats).buffer,
        );
        let at = 0;
        for (const field of [document.body, document.title]) {
          if (offset + field.length + 1 >= 2 ** 32)
            throw Error("Suffix experiment exceeds 32-bit corpus offsets");
          await tokenFile.write(
            Buffer.from(field.buffer, field.byteOffset, field.byteLength),
          );
          await tokenFile.write(Buffer.alloc(4));
          for (const id of field) {
            const bucket = id >>> 16;
            let sink = sinks.get(bucket);
            if (!sink)
              sinks.set(
                bucket,
                (sink = new Sink(
                  await open(output + `/staging/${bucket}.rows`, "w"),
                )),
              );
            if (sink.push(raw, at)) await sink.flush();
            at += ROW;
          }
          offset += field.length + 1;
          rows += field.length;
        }
        if (next % 10000 === 0)
          console.log("Suffix input", next, "documents", rows, "positions");
      }
      if (next !== stats.count) throw Error("Incomplete suffix documents");
    } finally {
      await tokenFile.close();
      await Promise.all([...sinks.values()].map((s) => s.close()));
    }
    extracted = { corpusGeneration, rows, tokens: offset, documents: next };
    await writeFile(rootPath, JSON.stringify(extracted));
  }
  const tokens = new Uint32Array(extracted.tokens),
    tokenBytes = Buffer.from(tokens.buffer),
    tf = await open(output + "/tokens", "r");
  try {
    for (let at = 0; at < tokenBytes.length; at += 64 * 1048576) {
      const n = Math.min(64 * 1048576, tokenBytes.length - at),
        r = await tf.read(tokenBytes, at, n, at);
      if (r.bytesRead !== n) throw Error("Truncated suffix token corpus");
    }
  } finally {
    await tf.close();
  }
  console.log("Suffix tokens loaded", tokens.length);
  // Split only oversized partitions. Terminal identical suffixes may stay large;
  // use global offset bytes as a final deterministic tie key after the sentinel.
  async function partition(
    path: string,
    depth: number,
    shift: number,
    terminal = false,
    higher = 0,
  ): Promise<string[]> {
    const size = (await stat(path)).size;
    if (size <= sortMiB * 1048576) return [path];
    const histogram = new Uint32Array(256);
    const value = (raw: Buffer, at: number) => {
      const offset = raw.readUInt32LE(at);
      return terminal ? offset : (tokens[offset + depth] ?? 0);
    };
    for await (const raw of rowChunks(path))
      for (let at = 0; at < raw.length; at += ROW)
        histogram[(value(raw, at) >>> shift) & 255]++;
    const occupied = Array.from(histogram, (_, i) => i).filter(
      (i) => histogram[i],
    );
    const next = (bucket: number) =>
      shift
        ? {
            depth,
            shift: shift - 8,
            terminal,
            higher: higher + bucket * 2 ** shift,
          }
        : {
            depth: depth + 1,
            shift: 24,
            terminal: terminal || (higher === 0 && bucket === 0),
            higher: 0,
          };
    if (occupied.length === 1) {
      const n = next(occupied[0]);
      if (terminal && !shift) throw Error("Unsplit unique suffix offsets");
      return partition(path, n.depth, n.shift, n.terminal, n.higher);
    }
    const sinks = new Map<number, Sink>();
    for (const bucket of occupied)
      sinks.set(bucket, new Sink(await open(path + "." + bucket, "w")));
    try {
      for await (const raw of rowChunks(path))
        for (let at = 0; at < raw.length; at += ROW) {
          const sink = sinks.get((value(raw, at) >>> shift) & 255)!;
          if (sink.push(raw, at)) await sink.flush();
        }
    } finally {
      await Promise.all([...sinks.values()].map((s) => s.close()));
    }
    await unlink(path);
    const parts: string[] = [];
    for (const bucket of occupied) {
      const n = next(bucket);
      parts.push(
        ...(await partition(
          path + "." + bucket,
          n.depth,
          n.shift,
          n.terminal,
          n.higher,
        )),
      );
    }
    return parts;
  }
  const names = (await readdir(output + "/staging"))
    .filter((n) => /^\d+\.rows$/.test(n))
    .sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0]));
  let partitions: string[] | undefined = await readFile(
    output + "/partitions.json",
    "utf8",
  ).then(JSON.parse, () => undefined);
  if (!partitions) {
    partitions = [];
    for (const name of names)
      partitions.push(
        ...(await partition(
          output + "/staging/" + name,
          0,
          8,
          false,
          Number(name.split(".")[0]) * 65536,
        )),
      );
    await writeFile(output + "/partitions.json", JSON.stringify(partitions));
  }
  const saved = await readFile(output + "/conversion.json", "utf8").then(
    JSON.parse,
    () => undefined,
  );
  const columns: SuffixColumn[] = [
      "documents",
      "positions",
      "offsets",
      "flags",
      "keys",
      ...Array.from({ length: 4 }, (_, i) => `score16-${i + 2}` as const),
      ...Array.from({ length: 4 }, (_, i) => `score8-${i + 2}` as const),
    ],
    handles = await Promise.all(
      columns.map(async (n) => {
        const handle = await open(output + "/" + n, saved ? "r+" : "w");
        if (saved) await handle.truncate(saved.sizes[n]);
        return handle;
      }),
    ),
    directory = await open(output + "/directory", saved ? "r+" : "w"),
    sizes = (saved?.sizes ??
      Object.fromEntries(columns.map((n) => [n, 0]))) as Record<
      SuffixColumn,
      number
    >,
    roots: SuffixManifest["directory"] = saved?.roots ?? [];
  let first = saved?.first ?? 0,
    dirOffset = saved?.dirOffset ?? 0,
    blocks: SuffixBlock[] = saved?.blocks ?? [];
  if (saved) await directory.truncate(dirOffset);
  async function flushDirectory() {
    if (!blocks.length) return;
    const raw = gzipSync(JSON.stringify(blocks), { level: 1 });
    await directory.write(raw, 0, raw.length, dirOffset);
    roots.push({
      low: blocks[0].low,
      high: blocks.at(-1)!.high,
      first: blocks[0].first,
      end: blocks.at(-1)!.first + blocks.at(-1)!.count,
      ref: { offset: dirOffset, length: raw.length },
    });
    dirOffset += raw.length;
    blocks = [];
  }
  try {
    for (let part = saved?.next ?? 0; part < partitions.length; part++) {
      const path = partitions[part];
      const raw = await readFile(path),
        words = new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4),
        count = raw.length / ROW,
        order = Uint32Array.from({ length: count }, (_, i) => i);
      order.sort((a, b) => compareSuffix(tokens, words[a * 7], words[b * 7]));
      for (let start = 0; start < count; start += BLOCK) {
        const n = Math.min(BLOCK, count - start),
          offsets = new Uint32Array(n),
          docs = new Uint32Array(n),
          positions = new Uint32Array(n),
          flags = new Uint16Array(n),
          score16 = Array.from({ length: 4 }, () => new Uint16Array(n)),
          score8 = Array.from({ length: 4 }, () => new Uint8Array(n)),
          maxima16 = [0, 0, 0, 0],
          maxima8 = [0, 0, 0, 0];
        let minDocument = stats.count;
        for (let j = 0; j < n; j++) {
          const at = order[start + j] * ROW;
          offsets[j] = raw.readUInt32LE(at);
          docs[j] = raw.readUInt32LE(at + 4);
          positions[j] = raw.readUInt32LE(at + 8);
          flags[j] = raw.readUInt16LE(at + 12);
          minDocument = Math.min(minDocument, docs[j]);
          for (let p = 0; p < 4; p++) {
            const a = (score16[p][j] = raw.readUInt16LE(at + 14 + p * 2)),
              b = (score8[p][j] = raw[at + 22 + p]);
            if (flags[j] & (7 << (p * 3))) {
              maxima16[p] = Math.max(maxima16[p], a);
              maxima8[p] = Math.max(maxima8[p], b);
            }
          }
        }
        const values: Uint8Array[] = [
            Buffer.from(docs.buffer),
            Buffer.from(positions.buffer),
            Buffer.from(offsets.buffer),
            Buffer.from(flags.buffer),
            encodeSuffixKeys(tokens, offsets),
            ...score16.map((a) => Buffer.from(a.buffer)),
            ...score8,
          ],
          refs = {} as SuffixBlock["columns"];
        for (let i = 0; i < columns.length; i++) {
          const data = gzipSync(values[i], { level: 1 }),
            name = columns[i];
          refs[name] = { offset: sizes[name], length: data.length };
          await handles[i].write(data, 0, data.length, sizes[name]);
          sizes[name] += data.length;
        }
        blocks.push({
          first,
          count: n,
          low: [...prefix(tokens, offsets[0])],
          high: [...prefix(tokens, offsets.at(-1)!)],
          columns: refs,
          maxima16,
          maxima8,
          minDocument,
        });
        first += n;
        if (blocks.length === 256) await flushDirectory();
      }
      await writeFile(
        output + "/conversion.json.tmp",
        JSON.stringify({
          next: part + 1,
          first,
          dirOffset,
          blocks,
          roots,
          sizes,
        }),
      );
      await rename(
        output + "/conversion.json.tmp",
        output + "/conversion.json",
      );
      await unlink(path);
      console.log("Suffix sorted", first, "/", extracted.rows, path);
    }
    await flushDirectory();
  } finally {
    await Promise.all(handles.map((h) => h.close()));
    await directory.close();
  }
  if (first !== extracted.rows) throw Error("Suffix row coverage mismatch");
  const files: SuffixManifest["files"] = {};
  for (const file of [...columns, "directory", "tokens"]) {
    files[file] = {
      bytes: (await stat(output + "/" + file)).size,
      sha256: await hashFile(output + "/" + file),
    };
  }
  const manifest: SuffixManifest = {
    format: "word-suffix-1",
    generation: "",
    corpusGeneration,
    count: stats.count,
    rows: first,
    analysis,
    fixed: { titleBoost: 2, avgBody: stats.avgBody, avgTitle: stats.avgTitle },
    quantizers: {
      q16: quantizer(stats.count, 16),
      q8: quantizer(stats.count, 8),
    },
    directory: roots,
    files,
  };
  manifest.generation = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
  await writeFile(output + "/manifest.json.tmp", JSON.stringify(manifest));
  await rename(output + "/manifest.json.tmp", output + "/manifest.json");
  await writeFile(
    output + "/construction.json",
    JSON.stringify({
      milliseconds: Date.now() - started,
      input: extracted,
      sortMiB,
      outputBytes: Object.values(files).reduce((n, f) => n + f.bytes, 0),
      stagingRetained: false,
    }),
  );
  return manifest;
}
