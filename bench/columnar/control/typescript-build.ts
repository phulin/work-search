import { DatabaseSync } from "node:sqlite";
import { openSync, writeSync, closeSync, readSync, renameSync } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  copyFile,
  link,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { jsonLines } from "../../../src/builder/jsonl.js";
import { tokenize } from "../../../src/query/tokenize.js";
import { tokenOffsets } from "../../../src/global/build.js";
import { bm25 } from "../../../src/query/engine.js";
import { crc32 } from "../../../src/format/codec.js";
import {
  PAGE,
  OBJECT,
  BLOCK,
  type Ref,
  type Branch,
  type Term,
  type Root,
  concat,
  u32,
  pack,
  encodeScores,
  encodeBranches,
  refAt,
  view,
} from "../../../src/columnar/format.js";

export class Packer {
  object = -1;
  at = 0;
  buffer = Buffer.alloc(OBJECT);
  constructor(
    readonly dir: string,
    readonly store = { next: 0, objects: [] as Root["objects"] },
  ) {}
  get objects() {
    return this.store.objects;
  }
  flush() {
    if (!this.at) return;
    const b = this.buffer.subarray(0, this.at),
      name = `plan-${this.object}.bin`,
      fd = openSync(`${this.dir}/${name}.writing`, "w");
    writeSync(fd, b);
    closeSync(fd);
    renameSync(`${this.dir}/${name}.writing`, `${this.dir}/${name}`);
    const checksums = [];
    for (let p = 0; p < b.length; p += PAGE)
      checksums.push(crc32(b.subarray(p, p + PAGE)));
    this.objects[this.object] = {
      name,
      size: b.length,
      sha256: createHash("sha256").update(b).digest("hex"),
      checksums,
    };
    this.object = -1;
    this.at = 0;
    this.buffer.fill(0);
  }
  put(b: Uint8Array): Ref {
    if (!b.length || b.length > OBJECT)
      throw Error("Invalid immutable blob size");
    let at = Math.ceil(this.at / 8) * 8;
    if (b.length <= PAGE && (at % PAGE) + b.length > PAGE)
      at = Math.ceil(at / PAGE) * PAGE;
    if (at + b.length > OBJECT) {
      this.flush();
      at = 0;
    }
    if (this.object < 0) this.object = this.store.next++;
    this.buffer.set(b, at);
    this.at = at + b.length;
    return [this.object, at, b.length];
  }
}
const zero: Ref = [0, 0, 0];
const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
export interface BuildOptions {
  input: string | string[];
  out: string;
  maxDocuments?: number;
  resumeFrom?: string;
}
/** Disk B-tree is the external sort. Its cache and all in-memory batches are bounded;
 * no legacy bundle and no corpus-sized postings/plan array is ever constructed. */
export async function buildColumnar(options: BuildOptions) {
  const started = performance.now(),
    out = options.out;
  await mkdir(out + "/packs", { recursive: true });
  const dbPath = out + "/sort.sqlite";
  await rm(dbPath, { force: true });
  const previous: Root | undefined = options.resumeFrom
    ? JSON.parse(await readFile(options.resumeFrom + "/root.json", "utf8"))
    : undefined;
  if (options.resumeFrom)
    await copyFile(options.resumeFrom + "/sort.sqlite", dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(
    "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-131072; PRAGMA temp_store=FILE;",
  );
  if (!previous)
    db.exec(`
    CREATE TABLE terms(id INTEGER PRIMARY KEY, term TEXT UNIQUE, df INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE docs(doc INTEGER PRIMARY KEY, id TEXT UNIQUE, bl INTEGER, tl INTEGER, record BLOB, forward BLOB, head BLOB);
    CREATE TABLE rows(term INTEGER, doc INTEGER, body BLOB, title BLOB, bf INTEGER, tf INTEGER, first BLOB, PRIMARY KEY(doc,term)) WITHOUT ROWID;
    CREATE TABLE plans(term TEXT PRIMARY KEY, df INTEGER, payload TEXT) WITHOUT ROWID; BEGIN;`);
  else db.exec("DELETE FROM plans");
  const getTerm = db.prepare("SELECT id FROM terms WHERE term=?"),
    addTerm = db.prepare("INSERT INTO terms(term) VALUES (?)"),
    addDf = db.prepare("UPDATE terms SET df=df+1 WHERE id=?"),
    addDoc = !previous
      ? db.prepare("INSERT INTO docs VALUES(?,?,?,?,?,?,?)")
      : undefined,
    addRow = db.prepare("INSERT INTO rows VALUES(?,?,?,?,?,?,?)");
  const ids = new Map<string, number>();
  const termId = (t: string) => {
    let id = ids.get(t);
    if (id !== undefined) return id;
    const row = getTerm.get(t);
    id = row ? Number(row.id) : Number(addTerm.run(t).lastInsertRowid);
    if (ids.size >= 500000) ids.delete(ids.keys().next().value!);
    ids.set(t, id);
    return id;
  };
  const packer = new Packer(out + "/packs"),
    corpus = createHash("sha256");
  let count = 0,
    bodySum = 0,
    titleSum = 0;
  if (previous && options.resumeFrom) {
    const manifest = JSON.parse(
      await readFile(options.resumeFrom + "/manifest.json", "utf8"),
    );
    count = previous.count;
    bodySum = manifest.bodyTokens;
    titleSum = manifest.titleTokens;
    const rr = refAt(
      view(
        (
          db
            .prepare("SELECT record FROM docs ORDER BY doc DESC LIMIT 1")
            .get() as any
        ).record,
      ),
      0,
    );
    for (let i = 0; i <= rr[0]; i++) {
      const old = previous.objects[i],
        path = out + "/packs/" + old.name;
      if (i < rr[0])
        await link(options.resumeFrom + "/packs/" + old.name, path).catch(() =>
          copyFile(options.resumeFrom + "/packs/" + old.name, path),
        );
      else
        await writeFile(
          path,
          (await readFile(options.resumeFrom + "/packs/" + old.name)).subarray(
            0,
            rr[1] + rr[2],
          ),
        );
      const b = await readFile(path),
        checksums = [];
      for (let p = 0; p < b.length; p += PAGE)
        checksums.push(crc32(b.subarray(p, p + PAGE)));
      packer.objects.push({
        name: old.name,
        size: b.length,
        sha256: createHash("sha256").update(b).digest("hex"),
        checksums,
      });
    }
    packer.store.next = packer.objects.length;
  }
  try {
    if (!previous) {
      ingest: for (const path of typeof options.input === "string"
        ? [options.input]
        : options.input)
        for await (const line of jsonLines(path)) {
          if (!line.trim()) continue;
          if (count >= (options.maxDocuments ?? Infinity)) break ingest;
          const d = JSON.parse(line);
          if (
            !d ||
            typeof d.id !== "string" ||
            !d.id ||
            typeof d.body !== "string" ||
            (d.title !== undefined && typeof d.title !== "string")
          )
            throw Error("Invalid corpus record");
          corpus.update(JSON.stringify(d) + "\n");
          const body = tokenOffsets(d.body),
            title = tokenize(d.title ?? ""),
            tokenIds = body.terms.map(termId),
            titleIds = title.map(termId);
          const forward: number[][] = [],
            snippets: Ref[] = [];
          for (
            let first = 0;
            first < Math.max(1, body.terms.length);
            first += 256
          ) {
            const lo = Math.max(0, first - 32),
              hi = Math.min(body.terms.length, first + 288),
              start = body.starts[lo] ?? 0,
              end = body.ends[hi - 1] ?? body.text.length;
            const tokens = pack(tokenIds.slice(lo, hi));
            const text = gzipSync(
              json({
                first: lo,
                text: body.text.slice(start, end),
                starts: body.starts.slice(lo, hi).map((n) => n - start),
                ends: body.ends.slice(lo, hi).map((n) => n - start),
              }),
              { level: 1 },
            );
            const tr = packer.put(tokens),
              sr = packer.put(text);
            snippets.push(sr);
            forward.push([lo, hi - lo, ...tr, ...sr]);
          }
          const fr = packer.put(u32(forward.flat())),
            rr = packer.put(
              gzipSync(
                json({
                  id: d.id,
                  title: d.title,
                  metadata: d.metadata,
                  preview: body.text.slice(0, 400),
                }),
                { level: 1 },
              ),
            );
          addDoc!.run(
            count,
            d.id,
            body.terms.length,
            title.length,
            u32(rr),
            u32(fr),
            u32(snippets[0]),
          );
          const postings = new Map<number, [number[], number[]]>();
          const append = (id: number, pos: number, f: number) => {
            let row = postings.get(id);
            if (!row) postings.set(id, (row = [[], []]));
            row[f].push(pos);
          };
          tokenIds.forEach((id, p) => append(id, p, 0));
          titleIds.forEach((id, p) => append(id, p, 1));
          for (const [id, [b, t]] of postings) {
            addDf.run(id);
            addRow.run(
              id,
              count,
              b.length ? pack(b, true) : null,
              t.length ? pack(t, true) : null,
              b.length,
              t.length,
              u32(snippets[Math.floor((b[0] ?? 0) / 256)]),
            );
          }
          count++;
          bodySum += body.terms.length;
          titleSum += title.length;
          if (count % 1000 === 0) {
            db.exec("COMMIT; BEGIN");
            console.log(
              "columnar ingest",
              count,
              Math.round((performance.now() - started) / 1000),
            );
          }
        }
      db.exec("COMMIT");
      console.log("columnar external sort", count);
      db.exec(`CREATE TABLE ordered(term INTEGER,doc INTEGER,body BLOB,title BLOB,bf INTEGER,tf INTEGER,first BLOB,PRIMARY KEY(term,doc)) WITHOUT ROWID;
        INSERT INTO ordered SELECT * FROM rows ORDER BY term,doc; DROP TABLE rows; ALTER TABLE ordered RENAME TO rows;`);
    }
    if (!count) throw Error("Empty corpus");
    const avgBody = bodySum / count,
      avgTitle = titleSum / count,
      corpusHash = previous?.corpusHash ?? corpus.digest("hex");
    const generation = createHash("sha256")
      .update(`CWS1:128:256:64:lanes\n${corpusHash}`)
      .digest("hex");
    packer.flush();
    // Independent physical lanes: fetching scores does not read through the
    // duplicated locator or position columns. Every lane still uses 256-KiB pages.
    const scores = new Packer(out + "/packs", packer.store),
      positionsLane = new Packer(out + "/packs", packer.store),
      locatorsLane = new Packer(out + "/packs", packer.store),
      plansLane = new Packer(out + "/packs", packer.store);
    const rows = db.prepare(
        "SELECT r.*, d.bl,d.tl,d.record,d.forward FROM rows r JOIN docs d USING(doc) WHERE term=? ORDER BY doc",
      ),
      savePlan = db.prepare("INSERT INTO plans VALUES(?,?,?)");
    let terms = 0;
    for (const e of db
      .prepare("SELECT * FROM terms ORDER BY id")
      .iterate() as Iterable<any>) {
      const levels: Branch[][] = [];
      let batch: any[] = [];
      const parent = (children: Branch[]): Branch => ({
        first: children[0].first,
        last: children.at(-1)!.last,
        count: children.reduce((s, c) => s + c.count, 0),
        height: children[0].height + 1,
        b: Math.max(...children.map((c) => c.b)),
        t: Math.max(...children.map((c) => c.t)),
        score: plansLane.put(encodeBranches(children)),
        positions: zero,
        locators: zero,
      });
      const push = (branch: Branch, level = 0) => {
        (levels[level] ??= []).push(branch);
        if (levels[level].length === 64) {
          const p = parent(levels[level]);
          levels[level] = [];
          push(p, level + 1);
        }
      };
      const flush = () => {
        if (!batch.length) return;
        const b = batch.map((r) => bm25(r.bf, e.df, count, r.bl, avgBody)),
          t = batch.map((r) => bm25(r.tf, e.df, count, r.tl, avgTitle));
        const pos: Uint8Array[] = [],
          offsets = [0];
        for (const r of batch) {
          const body = r.body ?? pack([], true),
            title = r.title ?? pack([], true),
            v = concat([u32([body.length]), body, title]);
          pos.push(v);
          offsets.push(offsets.at(-1)! + v.length);
        }
        const positions = positionsLane.put(
          concat([u32([batch.length]), u32(offsets), ...pos]),
        );
        const loc = concat(
          batch.map((r) => concat([r.record, r.forward, r.first])),
        );
        const locators = locatorsLane.put(loc),
          score = scores.put(
            encodeScores(
              batch.map((r) => r.doc),
              batch.map((r) => r.bf),
              batch.map((r) => r.tf),
              b,
              t,
            ),
          );
        push({
          first: batch[0].doc,
          last: batch.at(-1).doc,
          count: batch.length,
          height: 0,
          b: Math.max(...b),
          t: Math.max(...t),
          score,
          positions,
          locators,
        });
        batch = [];
      };
      for (const row of rows.iterate(e.id)) {
        batch.push(row);
        if (batch.length === BLOCK) flush();
      }
      flush();
      // At most 63 descriptors per level, including a short last group.
      for (let l = 0; l < levels.length - 1; l++)
        if (levels[l].length) {
          push(parent(levels[l]), l + 1);
          levels[l] = [];
        }
      const remaining = levels.at(-1)!;
      const tree = remaining.length === 1 ? remaining[0] : parent(remaining);
      const plan: Term = { id: e.id, df: e.df, tree };
      savePlan.run(e.term, e.df, JSON.stringify(plan));
      if (++terms % 10000 === 0) console.log("columnar terms", terms);
    }
    const hot: Record<string, Term> = Object.create(null);
    for (const e of db
      .prepare("SELECT term,payload FROM plans ORDER BY df DESC,term LIMIT 256")
      .iterate() as Iterable<any>)
      hot[e.term] = JSON.parse(e.payload);
    const documents: Ref[] = [];
    let docBatch: Uint8Array[] = [];
    const flushDocs = () => {
      if (docBatch.length) documents.push(locatorsLane.put(concat(docBatch)));
      docBatch = [];
    };
    const fds = new Map<number, number>();
    for (const d of db
      .prepare("SELECT * FROM docs ORDER BY doc")
      .iterate() as Iterable<any>) {
      let head = d.head;
      if (!head) {
        const ref = refAt(view(d.forward), 0);
        let fd = fds.get(ref[0]);
        if (fd === undefined)
          fds.set(
            ref[0],
            (fd = openSync(out + `/packs/plan-${ref[0]}.bin`, "r")),
          );
        head = Buffer.alloc(12);
        readSync(fd, head, 0, 12, ref[1] + 20);
      }
      docBatch.push(concat([d.record, d.forward, head]));
      if (docBatch.length === 4096) flushDocs();
    }
    flushDocs();
    for (const fd of fds.values()) closeSync(fd);
    const dictionaries: Root["dictionaries"] = [];
    let entries: [string, Term][] = [];
    const flushDict = () => {
      if (!entries.length) return;
      dictionaries.push({
        first: entries[0][0],
        last: entries.at(-1)![0],
        ref: plansLane.put(json(entries)),
      });
      entries = [];
    };
    for (const e of db
      .prepare("SELECT term,payload FROM plans ORDER BY term")
      .iterate() as Iterable<any>) {
      entries.push([e.term, JSON.parse(e.payload)]);
      if (entries.length === 256) flushDict();
    }
    flushDict();
    for (const lane of [scores, positionsLane, locatorsLane, plansLane])
      lane.flush();
    const root: Root = {
      format: "CWS1",
      generation,
      corpusHash,
      count,
      avgBody,
      avgTitle,
      documents,
      dictionaries,
      hot,
      objects: packer.objects,
    };
    await writeFile(out + "/root.json", JSON.stringify(root));
    await writeFile(
      out + "/manifest.json",
      JSON.stringify(
        {
          format: root.format,
          generation,
          corpusHash,
          count,
          terms,
          bodyTokens: bodySum,
          titleTokens: titleSum,
          buildMs: performance.now() - started,
          bytes: root.objects.reduce((s, o) => s + o.size, 0),
          source: options.input,
          maxDocuments: options.maxDocuments,
        },
        null,
        2,
      ),
    );
    return root;
  } finally {
    db.close();
  }
}
