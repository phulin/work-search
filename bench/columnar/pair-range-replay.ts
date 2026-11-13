import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { constructionHTTP } from "../../scripts/construction-http.js";
import { benchmarkToken } from "./token.js";
import {
  BuildStore,
  type Chunk,
} from "../../src/columnar/construction/runs.js";
import { pairRunEntries } from "../../src/columnar/construction/pair-occurrences.js";
const [dir, out] = process.argv.slice(2);
if (!out) throw Error("Use PAIR_BUILD OUTPUT_DIR");
await mkdir(out, { recursive: true });
const state = JSON.parse(await readFile(dir + "/build.json", "utf8")),
  inputs = state.levels["occurrences-5"],
  expected = state.levels["occurrences-6"][0],
  token = await benchmarkToken(),
  url = "https://work-search-cws-build-0.phulin.workers.dev",
  post = constructionHTTP(32),
  rows: any[] = [],
  startedAt = new Date().toISOString(),
  build = "native-pairs-1m-range-v1";
if (inputs.length !== 2 || !expected)
  throw Error("Replay requires completed final reference merge");
const health = await fetch(url + "/pair-range-health", {
  headers: { authorization: `Bearer ${token}` },
}).then((r) => r.json());
let saving = Promise.resolve();
async function call(path: string, task: string, value: any) {
  const started = performance.now();
  for (let i = 0; i < 60; i++) {
    const r = await post(
        url + path,
        token,
        JSON.stringify({ build, task, ...value }),
      ),
      text = await r.text();
    if (r.status === 503 && text.includes("capacity busy")) {
      await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
      continue;
    }
    if (!r.ok) throw Error(path + " " + r.status + " " + text.slice(0, 400));
    const result = JSON.parse(text);
    rows.push({ path, task, clientMs: performance.now() - started, ...result });
    saving = saving.then(() =>
      writeFile(
        out + "/requests.json",
        JSON.stringify({ startedAt, health, rows }),
      ),
    );
    await saving;
    return result.output;
  }
  throw Error("Capacity retries exhausted");
}
const indexed = (await call("/pair-restarts", "inputs", { runs: inputs })).runs,
  reference = (await call("/pair-restarts", "reference", { runs: [expected] }))
    .runs[0],
  pairs = state.selection.pairs,
  total = pairs.reduce((s: number, p: any) => s + p.cost, 0),
  boundaries = [0];
let cumulative = 0;
for (let i = 0; i + 1 < pairs.length; i++) {
  cumulative += pairs[i].cost;
  if (cumulative >= (total * boundaries.length) / 32 && boundaries.length < 32)
    boundaries.push(pairs[i + 1].key);
}
boundaries.push(2 ** 32);
const ranges = boundaries
    .slice(1)
    .map((endKey, i) => ({ firstKey: boundaries[i], endKey })),
  mergeStart = performance.now(),
  outputs = await Promise.all(
    ranges.map(
      async (range, i) =>
        (
          await call("/merge-pair-occurrences-range", "range-" + i, {
            runs: indexed,
            range,
          })
        ).run,
    ),
  ),
  mergeMs = performance.now() - mergeStart;
await writeFile(
  out + "/outputs.json",
  JSON.stringify({ startedAt, health, ranges, outputs, reference, mergeMs }),
);
// Validate complete packet bytes, including every position and context integer,
// against the frozen final merge. Download only bounded chunks, never an index.
const store = new BuildStore({} as R2Bucket);
let downloaded = 0;
store.get = async (ref: Chunk) => {
  const r = await fetch(
    `https://work-search-cws-upload.phulin.workers.dev/${ref.key}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(120000),
    },
  );
  if (!r.ok) throw Error("Validation read " + r.status);
  const b = new Uint8Array(await r.arrayBuffer());
  downloaded += b.length;
  if (
    b.length !== ref.size ||
    createHash("sha256").update(b).digest("hex") !== ref.sha256
  )
    throw Error("Validation checksum");
  return b;
};
let next = 0,
  packets = 0,
  bytes = 0;
const validationStart = performance.now();
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (;;) {
      const i = next++;
      if (i >= ranges.length) return;
      const a = pairRunEntries(store, reference, ranges[i]),
        b = pairRunEntries(store, outputs[i]);
      for (;;) {
        const [x, y] = await Promise.all([a.next(), b.next()]);
        if (x.done || y.done) {
          if (x.done !== y.done) throw Error("Different pair count");
          break;
        }
        if (
          x.value.key !== y.value.key ||
          Buffer.compare(x.value.packet, y.value.packet)
        )
          throw Error("Different pair packet " + x.value.key);
        packets++;
        bytes += x.value.packet.length;
      }
    }
  }),
);
await writeFile(
  out + "/summary.json",
  JSON.stringify(
    {
      startedAt,
      finishedAt: new Date().toISOString(),
      health,
      mergeMs,
      ranges: ranges.length,
      packets,
      bytes,
      downloaded,
      validationMs: performance.now() - validationStart,
      exactPacketBytes: true,
      caveats: [
        "One live replay while a separate full-corpus build was active; cache state was not controlled.",
        "Reference final merge was recovered from a saved acknowledgement after client timeouts; its complete original wall time is unavailable.",
      ],
    },
    null,
    2,
  ),
);
console.log({ mergeMs, packets, bytes, downloaded });
