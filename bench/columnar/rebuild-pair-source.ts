// Recover only the bounded accelerator inputs after the full build spool was
// reclaimed. No posting reconstruction, scoring conversion, or legacy index.
import { readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { jsonLines } from "../../src/builder/jsonl.js";
import { tokenize } from "../../src/query/tokenize.js";
import { Reader } from "../../src/columnar/storage.js";
import { OfflineObjects } from "../../src/columnar/offline.js";
import {
  refAt,
  view,
  pack,
  u32,
  type Root,
  type Term,
} from "../../src/columnar/format.js";
const [dir, input] = process.argv.slice(2),
  root: Root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  path = dir + "/pair-source.sqlite";
await rm(path, { force: true });
const db = new DatabaseSync(path),
  objects = new OfflineObjects(dir, root),
  source = {
    async read(key: string, o: number, n: number) {
      return objects.read([Number(key.match(/plan-(\d+)/)![1]), o, n]);
    },
  },
  reader = new Reader(root, source);
try {
  const top: [string, Term][] = [];
  for (const route of root.dictionaries) {
    const entries = JSON.parse(
      new TextDecoder().decode(await reader.read(route.ref)),
    ) as [string, Term][];
    for (const entry of entries) {
      if (top.length === 4096 && entry[1].df < top.at(-1)![1].df) continue;
      top.push(entry);
      top.sort(
        (a, b) => b[1].df - a[1].df || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
      );
      if (top.length > 4096) top.pop();
    }
  }
  const ids = new Map(top.map(([name, t]) => [name, t.id]));
  db.exec(
    "PRAGMA journal_mode=OFF;PRAGMA synchronous=OFF;CREATE TABLE terms(id INTEGER,term TEXT,df INTEGER);CREATE TABLE docs(doc INTEGER PRIMARY KEY,record BLOB,forward BLOB,head BLOB);CREATE TABLE rows(doc INTEGER,term INTEGER,title BLOB,tf INTEGER);BEGIN",
  );
  const term = db.prepare("INSERT INTO terms VALUES(?,?,?)"),
    doc = db.prepare("INSERT INTO docs VALUES(?,?,?,?)"),
    row = db.prepare("INSERT INTO rows VALUES(?,?,?,?)");
  for (const [name, t] of top) term.run(t.id, name, t.df);
  let n = 0,
    loc: DataView | undefined;
  const hash = createHash("sha256");
  for await (const line of jsonLines(input)) {
    if (!line.trim()) continue;
    const d = JSON.parse(line);
    hash.update(JSON.stringify(d) + "\n");
    if (n % 4096 === 0)
      loc = view(await reader.read(root.documents[Math.floor(n / 4096)]));
    const at = (n % 4096) * 36;
    doc.run(
      n,
      u32(refAt(loc!, at)),
      u32(refAt(loc!, at + 12)),
      u32(refAt(loc!, at + 24)),
    );
    const positions = new Map<number, number[]>();
    tokenize(d.title ?? "").forEach((t, p) => {
      const id = ids.get(t);
      if (id !== undefined) {
        const a = positions.get(id) ?? [];
        a.push(p);
        positions.set(id, a);
      }
    });
    for (const [id, ps] of positions) row.run(n, id, pack(ps, true), ps.length);
    if (++n % 10000 === 0) {
      db.exec("COMMIT;BEGIN");
      console.log("recovered pair inputs", n);
    }
  }
  db.exec("COMMIT");
  if (n !== root.count || hash.digest("hex") !== root.corpusHash)
    throw Error("Accelerator source corpus mismatch");
} finally {
  db.close();
  await objects.close();
}
