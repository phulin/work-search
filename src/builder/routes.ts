import {
  readFile,
  writeFile,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { gzipSync, createGzip, createGunzip } from "node:zlib";
import { openIndex, type PagedIndex } from "../format/paged.js";
import { BinaryIndex, type Entry } from "../format/index.js";
import { crc32 } from "../format/codec.js";
import {
  routeHash,
  ROUTE_BUCKETS,
  encodeRoutes,
  encodeRoutePage,
} from "../format/routes.js";
import { parallel } from "../storage/types.js";
export interface RouteRow {
  bucket: number;
  term: string;
  shard: number;
  hot: number;
  entry: Entry;
}
interface Shard {
  id: number;
  generation: string;
}
export function compareRouteRows(a: RouteRow, b: RouteRow) {
  return (
    a.bucket - b.bucket ||
    Buffer.compare(Buffer.from(a.term), Buffer.from(b.term)) ||
    a.shard - b.shard
  );
}
export async function* mergeRouteRows(sources: AsyncIterable<RouteRow>[]) {
  const iterators = sources.map((s) => s[Symbol.asyncIterator]()),
    heap: { row: RouteRow; key: Buffer; i: number }[] = [];
  const cmp = (a: (typeof heap)[number], b: (typeof heap)[number]) =>
    a.row.bucket - b.row.bucket ||
    Buffer.compare(a.key, b.key) ||
    a.row.shard - b.row.shard;
  function push(row: RouteRow, i: number) {
    const x = { row, key: Buffer.from(row.term), i };
    let p = heap.length;
    heap.push(x);
    while (p) {
      const parent = (p - 1) >> 1;
      if (cmp(heap[parent], x) <= 0) break;
      heap[p] = heap[parent];
      p = parent;
    }
    heap[p] = x;
  }
  try {
    for (const [i, iterator] of iterators.entries()) {
      const r = await iterator.next();
      if (!r.done) push(r.value, i);
    }
    while (heap.length) {
      const x = heap[0],
        last = heap.pop()!;
      if (heap.length) {
        let p = 0;
        while (p * 2 + 1 < heap.length) {
          let c = p * 2 + 1;
          if (c + 1 < heap.length && cmp(heap[c + 1], heap[c]) < 0) c++;
          if (cmp(last, heap[c]) <= 0) break;
          heap[p] = heap[c];
          p = c;
        }
        heap[p] = last;
      }
      yield x.row;
      const r = await iterators[x.i].next();
      if (!r.done) push(r.value, x.i);
    }
  } finally {
    await Promise.all(iterators.map((i) => i.return?.()));
  }
}
export async function buildRoutes(
  shards: Shard[],
  loadBundle: (s: Shard) => Promise<Uint8Array>,
  loadDictionary: (s: Shard) => Promise<Uint8Array>,
  out: string,
) {
  await mkdir(out + "/segments", { recursive: true });
  const sources: AsyncIterable<RouteRow>[] = [];
  const fresh = [...shards].sort((a, b) => a.id - b.id);
  const totals: Record<
    string,
    { count: number; bodyTokens: number; titleTokens: number }
  > = {};
  await parallel(fresh, 3, async (s) => {
    const path = out + "/segments/" + s.id;
    const done = await readFile(path + ".generation", "utf8").catch(() => "");
    const saved = await readFile(path + ".stats", "utf8").catch(() => "");
    if (done === s.generation && saved) {
      totals[s.id] = JSON.parse(saved);
      return;
    }
    const index = openIndex(await loadBundle(s)) as PagedIndex;
    if (index.generation !== s.generation || !index.root)
      throw Error("Routing bundle generation mismatch");
    totals[s.id] = {
      count: index.count,
      bodyTokens: index.count * index.avgBody,
      titleTokens: index.count * index.avgTitle,
    };
    const bytes = await loadDictionary(s),
      hot = new Map<string, Entry>();
    if (index.hotIndex)
      for (let i = 0; i < index.hotIndex.termCount; i++) {
        const e = index.hotIndex.entry(i);
        hot.set(e.term, e);
      }
    const rows: RouteRow[] = [];
    for (const p of index.root.dictionary) {
      const b = bytes.subarray(p.offset, p.offset + p.length);
      if (crc32(b) !== p.crc) throw Error("Routing source checksum mismatch");
      const page = new BinaryIndex(b);
      if (page.generation !== s.generation)
        throw Error("Routing source generation mismatch");
      for (let i = 0; i < page.termCount; i++) {
        const cold = page.entry(i),
          h = hot.get(cold.term),
          e = h ?? cold;
        rows.push({
          bucket: routeHash(e.term),
          term: e.term,
          shard: s.id,
          hot: h ? 1 : 0,
          entry: e,
        });
      }
    }
    rows.sort(compareRouteRows);
    const file = await open(path + ".next", "w");
    try {
      for (let i = 0; i < rows.length; i += 8192)
        await file.write(
          rows
            .slice(i, i + 8192)
            .map((r) => JSON.stringify(r) + "\n")
            .join(""),
        );
    } finally {
      await file.close();
    }
    await pipeline(
      createReadStream(path + ".next"),
      createGzip({ level: 1 }),
      createWriteStream(path + ".gz.next"),
    );
    await rename(path + ".gz.next", path + ".jsonl.gz");
    await unlink(path + ".next");
    await writeFile(path + ".stats", JSON.stringify(totals[s.id]));
    await writeFile(path + ".generation", s.generation);
    console.log("Prepared route segment", s.id, rows.length);
  });
  async function* segment(id: number) {
    const stream = createReadStream(out + "/segments/" + id + ".jsonl.gz").pipe(
        createGunzip(),
      ),
      lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) yield JSON.parse(line) as RouteRow;
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  for (const s of fresh) sources.push(segment(s.id));
  const pages: any[] = [],
    objects: any[] = [],
    candidates: { term: string; df: number }[] = [];
  let object = 0,
    offset = 0,
    file = await open(out + "/routes-0.bin", "w");
  async function close() {
    await file.close();
    const b = await readFile(out + `/routes-${object}.bin`);
    objects.push({
      name: `routes-${object}.bin`,
      size: b.length,
      sha256: createHash("sha256").update(b).digest("hex"),
    });
  }
  const hotCompare = (
    a: (typeof candidates)[number],
    b: (typeof candidates)[number],
  ) => b.df - a.df || Buffer.compare(Buffer.from(a.term), Buffer.from(b.term));
  async function flush(rows: RouteRow[]) {
    const raw = encodeRoutePage(rows);
    if (raw.length > 8 * 1048576) throw Error("Routing expansion limit");
    const b = gzipSync(raw, { level: 6 });
    if (offset + b.length > 64 * 1048576) {
      await close();
      object++;
      offset = 0;
      file = await open(out + `/routes-${object}.bin`, "w");
    }
    await file.write(b);
    pages.push({ object, offset, length: b.length, crc: crc32(b) });
    offset += b.length;
    for (let i = 0; i < rows.length;) {
      let j = i,
        df = 0,
        hot = true;
      while (j < rows.length && rows[j].term === rows[i].term) {
        df += rows[j].entry.df;
        hot &&= !!rows[j].hot;
        j++;
      }
      if (hot) candidates.push({ term: rows[i].term, df });
      i = j;
    }
    if (candidates.length > 32768) {
      candidates.sort(hotCompare);
      candidates.length = 8192;
    }
  }
  let bucket = 0,
    rows: RouteRow[] = [];
  for await (const row of mergeRouteRows(sources)) {
    while (row.bucket !== bucket) {
      await flush(rows);
      rows = [];
      bucket++;
      if (bucket >= ROUTE_BUCKETS) throw Error("Invalid routing sort");
    }
    rows.push(row);
  }
  await flush(rows);
  while (pages.length < ROUTE_BUCKETS) await flush([]);
  await close();
  candidates.sort(hotCompare);
  const stats = {
    count: 0,
    bodyTokens: 0,
    titleTokens: 0,
    df: Object.fromEntries(
      candidates.slice(0, 8192).map((c) => [c.term, c.df]),
    ),
  };
  for (const shard of fresh) {
    const t = totals[shard.id];
    stats.count += t.count;
    stats.bodyTokens += Math.round(t.bodyTokens);
    stats.titleTokens += Math.round(t.titleTokens);
  }
  const hot = candidates.slice(0, 8192).map((c) => c.term),
    generations = Object.fromEntries(shards.map((s) => [s.id, s.generation])),
    generation = createHash("sha256")
      .update(JSON.stringify({ shards: generations, objects, hot, stats }))
      .digest("hex"),
    binary = encodeRoutes({
      version: 1,
      generation,
      shards: generations,
      hot,
      pages,
      stats,
    });
  if (binary.length > 1048576) throw Error("Routing root exceeds 1 MiB");
  await writeFile(out + "/root.bin", binary);
  const manifest = { generation, objects, rootBytes: binary.length };
  await writeFile(out + "/manifest.json", JSON.stringify(manifest, null, 2));
  return manifest;
}
