import { DatabaseSync } from "node:sqlite";
import { open, readFile, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { crc32 } from "../format/codec.js";
import { gunzipSync } from "node:zlib";
import { PagePacker } from "./pack.js";
import {
  decodeTerm,
  encodeTerm,
  decodeRows,
  encodeDictionary,
  encodeRoot,
  type Address,
  type Root,
} from "./format.js";
export const MICRO_DOCS = 64;
// Appends a new immutable layout to the same logical corpus generation. Existing
// packs/roots remain valid; the exact selected root is checked by bundle SHA.
export async function addMicroPlans(out: string, docs = MICRO_DOCS) {
  if (![8, 16, 32, 64].includes(docs))
    throw Error("Invalid score window geometry");
  const manifest = JSON.parse(await readFile(out + "/manifest.json", "utf8")),
    root: Root = JSON.parse(await readFile(out + "/root.json", "utf8"));
  if (manifest.microDocs === docs) return manifest;
  const started = performance.now(),
    baseObjects = root.objects.length,
    packer = new PagePacker(out + "/packs", root.pageBytes, baseObjects);
  await packer.start();
  const db = new DatabaseSync(out + "/terms.sqlite");
  db.exec(
    "PRAGMA synchronous=OFF; PRAGMA journal_mode=OFF; PRAGMA cache_size=-8192; DROP TABLE IF EXISTS micro; CREATE TABLE micro(term TEXT,sort BLOB PRIMARY KEY,df INTEGER,payload BLOB,cost INTEGER)",
  );
  const insert = db.prepare("INSERT INTO micro VALUES(?,?,?,?,?)"),
    handles = new Map<number, ReturnType<typeof open>>();
  async function payload(ref: Address) {
    let task = handles.get(ref[0]);
    if (!task) {
      task = open(out + `/packs/plan-${ref[0]}.bin`, "r");
      handles.set(ref[0], task);
    }
    const b = Buffer.alloc(ref[2]);
    const r = await (await task).read(b, 0, b.length, ref[1]);
    if (r.bytesRead !== b.length || crc32(b) !== ref[3])
      throw Error("Truncated micro source");
    return gunzipSync(b);
  }
  let seen = 0;
  for (const row of db
    .prepare("SELECT * FROM terms ORDER BY sort")
    .iterate() as Iterable<any>) {
    const term = decodeTerm(row.payload),
      windows = new Map<number, number>();
    if (term.inline?.length) {
      for (const r of decodeRows(term.inline)) {
        const tile = Math.floor(r.doc / docs);
        windows.set(tile, Math.max(windows.get(tile) ?? 0, r.b + 2 * r.t));
      }
    } else
      for (const block of term.blocks) {
        for (const r of decodeRows(await payload(block.frequency))) {
          const tile = Math.floor(r.doc / docs);
          windows.set(tile, Math.max(windows.get(tile) ?? 0, r.b + 2 * r.t));
        }
      }
    term.windowDocs = docs === 64 ? undefined : docs;
    term.windows = [...windows].sort(([a], [b]) => a - b);
    const b = encodeTerm(term);
    insert.run(
      row.term,
      row.sort,
      row.df,
      b,
      b.length + row.term.length * 3 + 24,
    );
    if (++seen % 50000 === 0) console.log("Micro plans", seen);
  }
  for (const h of handles.values()) await (await h).close();
  db.exec(
    "CREATE INDEX micro_df ON micro(df DESC,sort); CREATE INDEX micro_cost ON micro(cost,sort)",
  );
  const dictionary: Root["dictionary"] = [];
  let pending: [string, Uint8Array][] = [],
    size = 0;
  async function flush() {
    if (!pending.length) return;
    dictionary.push({
      first: pending[0][0],
      last: pending.at(-1)![0],
      address: await packer.put(encodeDictionary(pending), true),
    });
    pending = [];
    size = 0;
  }
  for (const e of db
    .prepare("SELECT term,payload FROM micro ORDER BY sort")
    .iterate() as Iterable<any>) {
    if (size + e.payload.length + e.term.length * 3 + 24 > root.pageBytes * 0.7)
      await flush();
    pending.push([e.term, e.payload]);
    size += e.payload.length + e.term.length * 3 + 24;
  }
  await flush();
  root.dictionary = dictionary;
  const additions = await packer.finish();
  if (docs !== 64)
    for (const object of additions) {
      const name = object.name.replace(
        ".bin",
        "-" + object.sha256.slice(0, 16) + ".bin",
      );
      await rename(out + "/packs/" + object.name, out + "/packs/" + name);
      object.name = name;
    }
  root.objects = [...root.objects, ...additions];
  const reserve = JSON.stringify(root).length + 4096,
    roots: any[] = [];
  for (const old of manifest.roots) {
    let charge = 8;
    const selected = new Map<string, Uint8Array>();
    const take = (e: any) => {
      if (charge + e.cost + reserve <= old.budget) {
        selected.set(e.term, e.payload);
        charge += e.cost;
      }
    };
    for (const e of db
      .prepare("SELECT * FROM micro ORDER BY df DESC,sort")
      .iterate() as Iterable<any>) {
      if (charge > old.budget * 0.45) break;
      take(e);
    }
    for (const e of db
      .prepare("SELECT * FROM micro ORDER BY cost,sort")
      .iterate() as Iterable<any>) {
      if (selected.has(e.term)) continue;
      if (charge + e.cost + reserve > old.budget) break;
      take(e);
    }
    const hot = encodeDictionary(
        [...selected].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
      bundle = encodeRoot({ ...root, hotBytes: hot.length }, hot);
    if (bundle.length > old.budget) throw Error("Micro bundle overflow");
    await writeFile(out + "/" + old.name, bundle);
    roots.push({
      ...old,
      bundleBytes: bundle.length,
      hotTerms: selected.size,
      sha256: createHash("sha256").update(bundle).digest("hex"),
    });
  }
  const result = {
    ...manifest,
    objects: root.objects,
    roots,
    microDocs: docs,
    displaySeedTerms: undefined,
    microMs: performance.now() - started,
    baseObjects: manifest.baseObjects ?? baseObjects,
    layoutBaseObjects: baseObjects,
  };
  await writeFile(out + "/root.json", JSON.stringify(root));
  await writeFile(out + "/manifest.json", JSON.stringify(result, null, 2));
  db.close();
  return result;
}
