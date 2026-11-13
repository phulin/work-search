import { DatabaseSync } from "node:sqlite";
import { OfflineObjects } from "./offline.js";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { tokenize } from "../query/tokenize.js";
import { Packer } from "./packer.js";
import {
  type Root,
  type PairRoot,
  type Branch,
  type Ref,
  type Term,
  refAt,
  view,
  unpack,
  pack,
  concat,
  u32,
  encodeScores,
  encodeBranches,
} from "./format.js";
const zero: Ref = [0, 0, 0];
/** Select solely from corpus DF, occurrence volume and expected rejected work.
 * Forward token IDs are the streaming source; no display JSON is parsed. */
export async function buildColumnarPairs(
  baseDir: string,
  budgetBytes = 256 * 1048576,
  vocabulary = 4096,
  remote?: { url: string; token: string },
) {
  const started = performance.now(),
    base: Root = JSON.parse(await readFile(baseDir + "/root.json", "utf8")),
    out = baseDir + "/pairs";
  await mkdir(out + "/packs", { recursive: true });
  await rm(out + "/sort.sqlite", { force: true });
  const db = new DatabaseSync(out + "/sort.sqlite");
  db.exec(`PRAGMA journal_mode=OFF;PRAGMA synchronous=OFF;PRAGMA cache_size=-131072;PRAGMA temp_store=FILE;
    CREATE TABLE stats(pair TEXT PRIMARY KEY,a INTEGER,b INTEGER,df INTEGER,occ INTEGER) WITHOUT ROWID;
    CREATE TABLE rows(pair TEXT,doc INTEGER,bp BLOB,tp BLOB,bf INTEGER,tf INTEGER,record BLOB,forward BLOB,head BLOB,PRIMARY KEY(pair,doc)) WITHOUT ROWID;
    CREATE TABLE plans(pair TEXT PRIMARY KEY,df INTEGER,payload TEXT) WITHOUT ROWID;`);
  const objects = new OfflineObjects(baseDir, base, remote),
    read = (ref: Ref) => objects.read(ref);
  // Stream the dictionary and retain only a bounded corpus-selected vocabulary.
  // Accelerator construction consumes the published format, never a builder's
  // temporary database or a legacy bundle.
  let ranked: [string, Term][] = [];
  const prune = () => {
    ranked.sort(
      (a, b) => b[1].df - a[1].df || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    ranked.length = Math.min(ranked.length, vocabulary);
  };
  async function* dictionaryEntries(
    fences: Root["dictionaries"],
    height: number,
  ): AsyncGenerator<[string, Term]> {
    for (const fence of fences) {
      const data = JSON.parse(new TextDecoder().decode(await read(fence.ref)));
      if (height) yield* dictionaryEntries(data, height - 1);
      else yield* data as [string, Term][];
    }
  }
  for await (const entry of dictionaryEntries(
    base.dictionaries,
    base.dictionaryHeight ?? 0,
  )) {
    ranked.push(entry);
    if (ranked.length >= Math.max(16384, vocabulary * 2)) prune();
  }
  prune();
  const df = new Map(ranked.map(([, t]) => [t.id, t.df])),
    ids = new Map(ranked.map(([name, t]) => [name, t.id]));
  async function* documentRows() {
    let doc = 0;
    for (const reference of base.documents) {
      const raw = await read(reference);
      for (let at = 0; at < raw.length; at += 36) {
        yield {
          doc: doc++,
          record: raw.subarray(at, at + 12),
          forward: raw.subarray(at + 12, at + 24),
          head: raw.subarray(at + 24, at + 36),
        };
      }
    }
    if (doc !== base.count) throw Error("Document locator count mismatch");
  }
  const enumerate = async (d: any) => {
    const directory = view(await read(refAt(view(d.forward), 0))),
      tokens: number[][] = [[], []];
    for (let at = 0; at < directory.byteLength; at += 32) {
      const first = directory.getUint32(at, true),
        a = unpack(await read(refAt(directory, at + 8))),
        lo = (at / 32) * 256;
      for (let p = lo - first; p < Math.min(a.length, lo - first + 256); p++)
        tokens[0].push(a[p]);
    }
    const record = JSON.parse(
      gunzipSync(await read(refAt(view(d.record), 0))).toString(),
    );
    tokens[1] = tokenize(record.title ?? "").map(
      (t) => ids.get(t) ?? 0xffffffff,
    );
    d.directory = directory;
    const result = new Map<string, [number, number, number[], number[]]>();
    for (let f = 0; f < 2; f++)
      for (let p = 0; p + 1 < tokens[f].length; p++) {
        const a = tokens[f][p],
          b = tokens[f][p + 1];
        if (!df.has(a) || !df.has(b)) continue;
        const key = `@${a}:${b}`;
        let r = result.get(key);
        if (!r) result.set(key, (r = [a, b, [], []]));
        r[f === 0 ? 2 : 3].push(p);
      }
    return result;
  };
  const update = db.prepare(
    "INSERT INTO stats VALUES(?,?,?,?,?) ON CONFLICT(pair) DO UPDATE SET df=df+excluded.df,occ=occ+excluded.occ",
  );
  let stats = new Map<string, [number, number, number, number]>(),
    documents = 0;
  const flush = () => {
    db.exec("BEGIN");
    for (const [key, r] of stats) update.run(key, ...r);
    db.exec("COMMIT");
    stats.clear();
  };
  try {
    for await (const d of documentRows()) {
      for (const [key, [a, b, bp, tp]] of await enumerate(d)) {
        const r = stats.get(key);
        if (r) {
          r[2]++;
          r[3] += bp.length + tp.length;
        } else stats.set(key, [a, b, 1, bp.length + tp.length]);
      }
      if (stats.size > 250000) flush();
      if (++documents % 10000 === 0) console.log("pair stats", documents);
    }
    flush();
    db.exec(
      "CREATE TABLE selected(pair TEXT PRIMARY KEY,utility REAL,cost INTEGER) WITHOUT ROWID;BEGIN",
    );
    const select = db.prepare("INSERT INTO selected VALUES(?,?,?)");
    for (const p of db
      .prepare("SELECT * FROM stats")
      .iterate() as Iterable<any>) {
      const anchor = Math.min(df.get(p.a)!, df.get(p.b)!);
      if (anchor < Math.min(1024, base.count / 8) || p.df * 4 > anchor)
        continue;
      const cost = 320 + p.df * 72 + p.occ * 4,
        utility = ((anchor - p.df) * Math.log2(p.occ + 2)) / cost;
      select.run(p.pair, utility, cost);
    }
    db.exec("COMMIT");
    const selected = new Set<string>();
    let cost = 0;
    for (const p of db
      .prepare("SELECT * FROM selected ORDER BY utility DESC,pair")
      .iterate() as Iterable<any>) {
      if (cost + p.cost > budgetBytes) continue;
      cost += p.cost;
      selected.add(p.pair);
    }
    const insert = db.prepare("INSERT INTO rows VALUES(?,?,?,?,?,?,?,?,?)");
    documents = 0;
    db.exec("BEGIN");
    for await (const d of documentRows()) {
      const pairs = await enumerate(d),
        directory = (d as any).directory as DataView;
      for (const [key, [, , bp, tp]] of pairs) {
        if (!selected.has(key)) continue;
        const frame = Math.floor((bp[0] ?? 0) / 256),
          head = refAt(directory, frame * 32 + 20);
        insert.run(
          key,
          d.doc,
          pack(bp, true),
          pack(tp, true),
          bp.length,
          tp.length,
          d.record,
          d.forward,
          u32(head),
        );
      }
      if (++documents % 1000 === 0) {
        db.exec("COMMIT;BEGIN");
        if (documents % 10000 === 0) console.log("pair rows", documents);
      }
    }
    db.exec("COMMIT");
    const packer = new Packer(out + "/packs"),
      positions = new Packer(out + "/packs", packer.store),
      locators = new Packer(out + "/packs", packer.store),
      plans = new Packer(out + "/packs", packer.store),
      save = db.prepare("INSERT INTO plans VALUES(?,?,?)"),
      get = db.prepare("SELECT * FROM rows WHERE pair=? ORDER BY doc");
    let coveredDocs = 0,
      occurrences = 0;
    for (const p of db
      .prepare(
        "SELECT s.* FROM stats s JOIN selected x USING(pair) ORDER BY s.pair",
      )
      .iterate() as Iterable<any>) {
      if (!selected.has(p.pair)) continue;
      let batch: any[] = [],
        levels: Branch[][] = [];
      const parent = (a: Branch[]): Branch => ({
        first: a[0].first,
        last: a.at(-1)!.last,
        count: a.reduce((s, b) => s + b.count, 0),
        height: a[0].height + 1,
        b: 0,
        t: 0,
        score: plans.put(encodeBranches(a)),
        positions: zero,
        locators: zero,
      });
      const push = (b: Branch, l = 0) => {
        (levels[l] ??= []).push(b);
        if (levels[l].length === 64) {
          const q = parent(levels[l]);
          levels[l] = [];
          push(q, l + 1);
        }
      };
      const flushRows = () => {
        if (!batch.length) return;
        const payload: Uint8Array[] = [],
          offsets = [0];
        for (const r of batch) {
          const b = concat([u32([r.bp.length]), r.bp, r.tp]);
          payload.push(b);
          offsets.push(offsets.at(-1)! + b.length);
        }
        const n = batch.length;
        push({
          first: batch[0].doc,
          last: batch.at(-1).doc,
          count: n,
          height: 0,
          b: 0,
          t: 0,
          score: packer.put(
            encodeScores(
              batch.map((r) => r.doc),
              batch.map((r) => r.bf),
              batch.map((r) => r.tf),
              new Array(n).fill(0),
              new Array(n).fill(0),
            ),
          ),
          positions: positions.put(
            concat([u32([n]), u32(offsets), ...payload]),
          ),
          locators: locators.put(
            concat(batch.map((r) => concat([r.record, r.forward, r.head]))),
          ),
        });
        batch = [];
      };
      for (const r of get.iterate(p.pair)) {
        batch.push(r);
        if (batch.length === 128) flushRows();
      }
      flushRows();
      for (let l = 0; l < levels.length - 1; l++)
        if (levels[l].length) {
          push(parent(levels[l]), l + 1);
          levels[l] = [];
        }
      const a = levels.at(-1)!;
      save.run(
        p.pair,
        p.df,
        JSON.stringify({
          id: 0,
          df: p.df,
          tree: a.length === 1 ? a[0] : parent(a),
        }),
      );
      coveredDocs += p.df;
      occurrences += p.occ;
    }
    const dictionaries: Root["dictionaries"] = [],
      hot: Record<string, Term> = {},
      entries: [string, Term][] = [];
    const flushDict = () => {
      if (!entries.length) return;
      dictionaries.push({
        first: entries[0][0],
        last: entries.at(-1)![0],
        ref: plans.put(new TextEncoder().encode(JSON.stringify(entries))),
      });
      entries.length = 0;
    };
    for (const p of db
      .prepare("SELECT * FROM plans ORDER BY pair")
      .iterate() as Iterable<any>) {
      entries.push([p.pair, JSON.parse(p.payload)]);
      if (entries.length === 256) flushDict();
    }
    flushDict();
    for (const lane of [packer, positions, locators, plans]) lane.flush();
    const generation = createHash("sha256")
        .update(`CWP1:${base.generation}:${budgetBytes}:${vocabulary}`)
        .digest("hex"),
      root: PairRoot = {
        format: "CWP1",
        generation,
        baseGeneration: base.generation,
        count: base.count,
        objects: packer.objects,
        dictionaries,
        hot,
        coverage: {
          vocabulary: ranked.length,
          pairs: selected.size,
          documents: coveredDocs,
          occurrences,
          budgetBytes,
        },
      };
    await writeFile(baseDir + "/pairs-root.json", JSON.stringify(root));
    await writeFile(
      out + "/manifest.json",
      JSON.stringify(
        {
          generation,
          baseGeneration: base.generation,
          coverage: root.coverage,
          bytes: root.objects.reduce((s, o) => s + o.size, 0),
          buildMs: performance.now() - started,
        },
        null,
        2,
      ),
    );
    return root;
  } finally {
    await objects.close();
    db.close();
  }
}
