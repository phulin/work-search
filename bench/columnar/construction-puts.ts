/** Local construction against a counting R2 implementation. Real corpus input,
 * actual PUT calls/bytes, no network, no extrapolated full-build timing. */
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createGunzip, gzipSync } from "node:zlib";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { crc32 } from "../../src/format/codec.js";
import { u32, unpack } from "../../src/columnar/format.js";
import { scanText } from "../../src/columnar/construction/text.js";
import { ENGLISH_ANALYSIS } from "../../src/query/analysis.js";

const count = Number(process.argv[2] ?? 4096),
  output = process.argv[3] ?? "work/construction-puts.json",
  docs: any[] = [],
  generation = "a".repeat(64),
  sourceObjects = new Map<string, any>(),
  pointers: number[] = [];
const file = createReadStream("work/columnar-corpus-1m.jsonl.gz"),
  gzip = file.pipe(createGunzip()),
  lines = createInterface({ input: gzip, crlfDelay: Infinity });
try {
  for await (const line of lines) {
    if (line.trim()) docs.push(JSON.parse(line));
    if (docs.length === count) break;
  }
} finally {
  lines.close();
  gzip.destroy();
  file.destroy();
}
if (docs.length !== count) throw Error("Incomplete construction sample");
const words = new Set<string>();
for (const [i, d] of docs.entries()) {
  for (const text of [d.body, d.title ?? ""])
    for (const t of scanText(text, ENGLISH_ANALYSIS).tokens())
      words.add(t.word);
  const body = gzipSync(d.body),
    info = Buffer.from(JSON.stringify({ ...d, body: undefined }));
  for (const [name, bytes] of [
    [`content-${i}.bin`, body],
    [`info-${i}.bin`, info],
  ] as const)
    sourceObjects.set(`${generation}/${name}`, {
      bytes,
      customMetadata: { generation },
    });
  pointers.push(i, 0, body.length, crc32(body), i, 0, info.length, crc32(info));
}
sourceObjects.set(`${generation}/contentmap-0.bin`, {
  bytes: u32(pointers),
  customMetadata: { generation },
});
const sourceRoot = {
    format: "R2-source-v1",
    documents: count,
    parts: [
      { part: 0, generation, first: 0, count, inputSha256: "b".repeat(64) },
    ],
  },
  ids = [...words].sort().map((w, i) => [w, i + 1]),
  root = {
    generation,
    analysis: ENGLISH_ANALYSIS,
    count,
    objects: [],
    idRouting: { dictionaries: [] },
  },
  hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex"),
  results: any[] = [];
for (const [label, base, ingestCount, groupCount] of [
  ["control", "work/verification-gets-control", 128, 128],
  ["candidate", ".", 512, 1024],
] as const) {
  const load = (name: string) =>
      import(
        pathToFileURL(resolve(base, `src/columnar/construction/${name}.ts`))
          .href
      ),
    { createConstructionWorker } = await load("worker"),
    { BuildStore, RunReader } = await load("runs"),
    worker = createConstructionWorker(sourceRoot, label),
    objects = new Map(sourceObjects),
    counts = { put: 0, get: 0, head: 0, bytes: 0 },
    bucket = {
      async get(key: string, options?: any) {
        counts.get++;
        const o = objects.get(key);
        if (!o) return null;
        const data = options?.range
          ? o.bytes.subarray(
              options.range.offset,
              options.range.offset + options.range.length,
            )
          : o.bytes;
        return {
          size: o.bytes.length,
          customMetadata: o.customMetadata,
          arrayBuffer: async () => Uint8Array.from(data).buffer,
          json: async () => JSON.parse(Buffer.from(data).toString()),
        };
      },
      async head(key: string) {
        counts.head++;
        const o = objects.get(key);
        return o && { size: o.bytes.length, customMetadata: o.customMetadata };
      },
      async put(key: string, value: Uint8Array, options?: any) {
        counts.put++;
        counts.bytes += value.byteLength;
        const bytes = Uint8Array.from(value);
        objects.set(key, {
          bytes,
          customMetadata: options?.customMetadata ?? {},
        });
        return { key, size: bytes.length };
      },
    },
    store = new BuildStore(bucket),
    start = performance.now();
  let task = 0,
    peakRss = process.memoryUsage().rss;
  async function call(path: string, value: any) {
    const response = await worker.fetch(
      new Request("https://local" + path, {
        method: "POST",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          build: label,
          task: `task-${task++}`,
          ...value,
        }),
      }),
      { INDEX: bucket, INTERNAL_TOKEN: "test" },
    );
    const result = (await response.json()) as any;
    if (!response.ok) throw Error(JSON.stringify(result));
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    return result.output ?? result;
  }
  const runs: any[] = [];
  for (let first = 0; first < count;) {
    const run = await call("/ingest", {
      first,
      count: Math.min(ingestCount, count - first),
      analysis: ENGLISH_ANALYSIS,
    });
    runs.push(run);
    first = run.next;
  }
  const ingested = { ...counts };
  let current = runs;
  while (current.length > 1) {
    const next: any[] = [];
    for (let at = 0; at < current.length; at += 16) {
      const group = current.slice(at, at + 16);
      if (group.length === 1) {
        next.push(group[0]);
        continue;
      }
      let state: any;
      const chunks: any[] = [];
      do {
        const result = await call("/merge", { runs: group, state });
        state = result.state;
        chunks.push(...result.chunks);
      } while (!state.done);
      next.push({
        first: group[0].first,
        next: group.at(-1).next,
        count: group.reduce((n, r) => n + r.count, 0),
        bodyTokens: group.reduce((n, r) => n + r.bodyTokens, 0),
        titleTokens: group.reduce((n, r) => n + r.titleTokens, 0),
        chunks,
      });
    }
    current = next;
  }
  const staged = { ...counts },
    digest = createHash("sha256"),
    reader = new RunReader(store, current[0].chunks);
  for (let row; (row = await reader.peek());) {
    digest.update(row);
    reader.consume(row);
  }
  const sortedSha256 = digest.digest("hex"),
    rootRef = await store.put(Buffer.from(JSON.stringify(root))),
    vocabularyRef = await store.put(
      gzipSync(JSON.stringify({ generation, first: 0, end: count, ids })),
    );
  const beforeDocuments = { ...counts },
    packageHashes: string[] = [];
  for (let first = 0; first < count;) {
    const result = await call("/grouped-documents", {
        rootRef,
        vocabularyRef,
        generation,
        first,
        count: Math.min(groupCount, count - first),
      }),
      group = result.group,
      raw = objects.get(`${group.sha256}/plan-0.bin`).bytes,
      offsets = unpack(Buffer.from(group.offsets, "base64"));
    for (let i = 0; i + 1 < offsets.length; i++)
      packageHashes.push(hash(raw.subarray(offsets[i], offsets[i + 1])));
    first = result.end;
  }
  results.push({
    label,
    documents: count,
    ingestTasks: runs.length,
    ingest: ingested,
    staging: staged,
    documentsPass: {
      put: counts.put - beforeDocuments.put,
      bytes: counts.bytes - beforeDocuments.bytes,
    },
    totalPut: staged.put + counts.put - beforeDocuments.put,
    sortedSha256,
    packagesSha256: hash(Buffer.from(packageHashes.join("\n"))),
    packageCount: packageHashes.length,
    wallMs: performance.now() - start,
    processPeakRssObserved: peakRss,
  });
}
if (
  results[0].sortedSha256 !== results[1].sortedSha256 ||
  results[0].packagesSha256 !== results[1].packagesSha256
)
  throw Error("Construction output differs");
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      kind: "Local actual Worker-handler PUT counts; construction sample from retained 1M corpus, not full-generation counts",
      results,
      reduction: 1 - results[1].totalPut / results[0].totalPut,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(results, null, 2));
