import { decodeRows, type Row, type Term, type Address } from "./format.js";
import type { PageReader } from "./storage.js";
import type { SearchRuntime } from "../query/runtime.js";
const key = (r: Address) => r.join(":");
/** Seed presence is exact; missing seed entries are unknown and must be fetched.
 * All terms, including negative clauses, are completed before a document scores. */
export async function completeSeeds(
  plans: Map<string, Term>,
  seeds: Map<string, Row[]>,
  positive: readonly string[],
  reader: PageReader,
  cache: SearchRuntime,
  options: {
    field: string;
    boost: number;
    maxRaw: number;
    seen: Set<number>;
    after?: { score: number; doc: number };
  },
) {
  const maps = new Map(
    [...seeds].map(([t, rs]) => [t, new Map(rs.map((r) => [r.doc, r]))]),
  );
  const estimates = new Map<number, number>();
  for (const term of positive)
    for (const r of seeds.get(term) ?? []) {
      const score =
        (options.field !== "title" ? r.b : 0) +
        (options.field !== "body" ? options.boost * r.t : 0);
      estimates.set(r.doc, (estimates.get(r.doc) ?? 0) + score);
    }
  const ranked = [...estimates]
    .filter(
      ([doc, score]) =>
        !options.seen.has(doc) &&
        (!options.after || score <= options.after.score),
    )
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const refs = new Map<string, { ref: Address; term: string }>(),
    docs = new Set<number>(),
    pages = new Set<string>();
  let raw = 0;
  for (const [doc] of ranked) {
    if (docs.size >= 64) break;
    const missing: { ref: Address; term: string }[] = [];
    for (const [term, t] of plans) {
      if (maps.get(term)?.has(doc) || t.inline?.length) continue;
      let lo = 0,
        hi = t.blocks.length;
      while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if (t.blocks[m].last < doc) lo = m + 1;
        else hi = m;
      }
      const block = t.blocks[lo];
      if (block && block.first <= doc)
        missing.push({ ref: block.frequency, term });
    }
    const nextPages = new Set(pages);
    let extra = 0;
    for (const { ref } of missing) {
      if (!refs.has(key(ref))) extra += ref[4];
      for (
        let p = Math.floor(ref[1] / reader.root.pageBytes);
        p <= Math.floor((ref[1] + ref[2] - 1) / reader.root.pageBytes);
        p++
      )
        nextPages.add(ref[0] + ":" + p);
    }
    if (
      raw + extra > Math.min(options.maxRaw, 1048576) ||
      nextPages.size * reader.root.pageBytes > 16 * 1048576
    )
      continue;
    for (const item of missing) refs.set(key(item.ref), item);
    for (const p of nextPages) pages.add(p);
    raw += extra;
    docs.add(doc);
  }
  const entries = [...refs],
    bytes = await reader.readMany(
      entries.map(([, n]) => n.ref),
      "complete-seeds",
    );
  for (let i = 0; i < entries.length; i++) {
    const [id, { ref, term }] = entries[i],
      rows = decodeRows(bytes[i]);
    cache.set(id, rows, ref[4] * 6 + rows.length * 256);
    for (const row of rows)
      if (docs.has(row.doc) && !maps.get(term)!.has(row.doc))
        maps.get(term)!.set(row.doc, row);
  }
  const rows = new Map(
    [...maps].map(([t, m]) => [
      t,
      [...m.values()]
        .filter((r) => docs.has(r.doc))
        .sort((a, b) => a.doc - b.doc),
    ]),
  );
  return { rows, docs, blocks: refs.size };
}
