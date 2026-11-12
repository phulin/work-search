import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, open } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { SearchRuntime } from "../query/runtime.js";
import { crc32, decoder } from "../format/codec.js";
import {
  decodeRows,
  encodeRows,
  decodeTerm,
  encodeTerm,
  encodeDictionary,
  encodeRoot,
  type Address,
  type Root,
} from "./format.js";
// Corpus-frequency selected term heads, not cached query responses or phrases.
export async function addDisplaySeeds(out: string, reservedBytes = 0) {
  const manifest = JSON.parse(await readFile(out + "/manifest.json", "utf8"));
  if (manifest.displaySeedTerms === 64) return manifest;
  const root: Root = JSON.parse(await readFile(out + "/root.json", "utf8")),
    db = new DatabaseSync(out + "/terms.sqlite"),
    heads = new Map<string, Uint8Array>(),
    cache = new SearchRuntime(8 * 1048576),
    files = new Map<number, ReturnType<typeof open>>();
  async function read(ref: Address) {
    const key = ref.join(":"),
      cached = cache.get<Uint8Array>(key);
    if (cached) return cached;
    let task = files.get(ref[0]);
    if (!task) {
      task = open(out + `/packs/plan-${ref[0]}.bin`, "r");
      files.set(ref[0], task);
    }
    const b = Buffer.alloc(ref[2]),
      r = await (await task).read(b, 0, b.length, ref[1]);
    if (r.bytesRead !== b.length || crc32(b) !== ref[3])
      throw Error("Display seed source corruption");
    const raw = gunzipSync(b);
    cache.set(key, raw, raw.length);
    return raw;
  }
  for (const e of db
    .prepare(
      "SELECT * FROM micro WHERE term<>'' ORDER BY df DESC,sort LIMIT 64",
    )
    .iterate() as Iterable<any>) {
    const t = decodeTerm(e.payload),
      rows = t.seeds?.length ? decodeRows(t.seeds) : [],
      best = [...rows]
        .sort((a, b) => b.b + 2 * b.t - (a.b + 2 * a.t) || a.doc - b.doc)
        .slice(0, 20),
      selected = new Set(best.map((r) => r.doc));
    for (const row of rows) {
      if (!selected.has(row.doc)) continue;
      row.recordData = decoder.decode(await read(row.record));
      const record = JSON.parse(row.recordData);
      if (record.id !== row.id) throw Error("Display seed identity");
      const frame = JSON.parse(decoder.decode(await read(row.passage))),
        pos = row.first - frame.first;
      let start = 0,
        end = Math.min(400, frame.text.length);
      if (pos >= 0 && pos < frame.starts.length) {
        start = Math.max(0, frame.starts[pos] - 160);
        end = Math.min(frame.text.length, frame.ends[pos] + 240);
      }
      row.excerpt =
        (frame.first || start ? "…" : "") +
        frame.text.slice(start, end).trim() +
        (end < frame.text.length ? "…" : "");
    }
    t.seeds = encodeRows(rows, false, true);
    heads.set(e.term, encodeTerm(t));
  }
  const compact = (e: any) => {
    const t = decodeTerm(e.payload);
    t.seeds = undefined;
    const payload = heads.get(e.term) ?? encodeTerm(t);
    return { ...e, payload, cost: payload.length + e.term.length * 3 + 24 };
  };
  const roots: any[] = [];
  for (const old of manifest.roots) {
    const reserve = JSON.stringify(root).length + 4096 + reservedBytes,
      selected = new Map<string, Uint8Array>();
    let charge = 8;
    const take = (e: any) => {
      if (charge + e.cost + reserve <= old.budget) {
        selected.set(e.term, e.payload);
        charge += e.cost;
      }
    };
    for (const entry of db
      .prepare("SELECT * FROM micro ORDER BY df DESC,sort")
      .iterate() as Iterable<any>) {
      if (charge > old.budget * 0.45) break;
      take(compact(entry));
    }
    for (const entry of db
      .prepare("SELECT * FROM micro ORDER BY cost,sort")
      .iterate() as Iterable<any>) {
      if (selected.has(entry.term)) continue;
      const e = compact(entry);
      if (charge + e.cost + reserve > old.budget) continue;
      take(e);
      if (charge + reserve > old.budget - 256) break;
    }
    const hot = encodeDictionary(
        [...selected].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
      bundle = encodeRoot({ ...root, hotBytes: hot.length }, hot);
    if (bundle.length + reservedBytes > old.budget)
      throw Error("Display bundle budget");
    await writeFile(out + `/bundle-heads-${old.budget / 1048576}.bin`, bundle);
    roots.push({
      ...old,
      displayName: `bundle-heads-${old.budget / 1048576}.bin`,
      displayBytes: bundle.length,
      displayHotTerms: selected.size,
      displaySha256: createHash("sha256").update(bundle).digest("hex"),
    });
  }
  for (const f of files.values()) await (await f).close();
  db.close();
  const result = { ...manifest, roots, displaySeedTerms: 64 };
  await writeFile(out + "/manifest.json", JSON.stringify(result, null, 2));
  return result;
}
