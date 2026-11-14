/** No-delay physical-layout accounting, with an optional Reader diagnostic hook. */
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { LocalObjects } from "./local-storage.js";
import { SimulatedIO } from "./latency-model.js";
import type { Branch, Ref } from "../../src/columnar/format.js";
import { decodeScores } from "../../src/columnar/format.js";
let base = process.env.CWS_SOURCE ?? ".";
const label = process.env.CWS_LABEL ?? "baseline",
  out = "work/boolean-candidates";
const originalSource = base;
if (process.env.CWS_INSTRUMENT_CONTROL === "1") {
  base = out + "/diagnostic-control";
  await cp(originalSource + "/src", base + "/src", { recursive: true });
  const searchPath = base + "/src/columnar/search.ts",
    storagePath = base + "/src/columnar/storage.ts",
    search = await readFile(searchPath, "utf8"),
    marker = "      const essential = essentialTerms(\n          blocks,";
  if (!search.includes(marker))
    throw Error("Control diagnostic hook location changed");
  await writeFile(
    searchPath,
    search.replace(
      marker,
      "      if (candidateMask) reader.inspectCandidateBlocks?.(blocks, candidateMask, lo);\n" +
        marker,
    ),
  );
  await writeFile(
    storagePath,
    (await readFile(storagePath, "utf8")).replace(
      "export class Reader {",
      "export class Reader {\n  inspectCandidateBlocks?: (blocks: any[][], mask: Uint8Array, first: number) => void;",
    ),
  );
}
const load = (n: string) =>
  import(pathToFileURL(resolve(base, "src/columnar/" + n + ".ts")).href);
const [
  { ColumnarIndex },
  { Reader, Memory, Lru },
  { TermDirectory },
  { DocumentDirectory },
  { PairRouter },
  { ScoreBatch },
] = await Promise.all(
  [
    "search",
    "storage",
    "term-directory",
    "document-directory",
    "pair-router",
    "score-batch",
  ].map(load),
);
const dir = "work/columnar-worker-stem-1m",
  pairs = "work/columnar-complete-pairs-1m",
  root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  contract = JSON.parse(
    await readFile(
      "bench/results/columnar/no-crc-1m/cpu-contract.json",
      "utf8",
    ),
  );
const source = new LocalObjects(root, "work/columnar-local-data");
source.namedDirectory = pairs;
const io = new SimulatedIO(
  source,
  {
    r2Ms: 20,
    sharedMs: 2,
    r2MiBPerSecond: 100,
    sharedMiBPerSecond: 1000,
    jitterMs: 0,
    seed: 20269033,
  },
  1024,
);
io.delaysEnabled = false;
const memory = new Memory();
memory.pages = new Lru(12 * 1048576);
const directory = new TermDirectory(
    await readFile(dir + "/directory.bin"),
    root.count,
  ),
  index = new ColumnarIndex(
    root,
    undefined,
    directory,
    undefined,
    new DocumentDirectory(await readFile(dir + "/documents.bin")),
    {
      router: new PairRouter(await readFile(pairs + "/router.bin")),
      presence: JSON.parse(await readFile(pairs + "/presence.json", "utf8")),
      N: 100,
      M: 1000,
    },
  );
const scope = new AsyncLocalStorage<boolean>();
await mkdir(out, { recursive: true });
const rows = [];
for (const sid of [4, 5, 7]) {
  const s = contract.scenarios[sid];
  async function run() {
    const refs = new Map<
        string,
        { ref: Ref; overlap: boolean; visits: number; candidates: Set<number> }
      >(),
      transfers = new Map<string, number>(),
      sharedTransfers = new Map<string, { calls: number; bytes: number }>(),
      scheduled = new Set<string>(),
      scoreData = new WeakMap<Uint8Array, string>(),
      decoded = new Map<string, { count: number; bytes: number }>(),
      deferred: Promise<unknown>[] = [];
    let maskCandidates = 0;
    const rawSource = {
      ...io.source,
      read: async (key: string, offset: number, length: number) => {
        if (scope.getStore()) {
          const k = key + ":" + offset + ":" + length;
          transfers.set(k, (transfers.get(k) ?? 0) + 1);
        }
        return io.source.read(key, offset, length);
      },
      readPage: io.source.readPage
        ? async (key: string, offset: number, length: number, sha?: string) => {
            if (scope.getStore()) {
              const k = key + ":" + offset + ":" + length;
              transfers.set(k, (transfers.get(k) ?? 0) + 1);
            }
            return io.source.readPage!(key, offset, length, sha);
          }
        : undefined,
    };
    const reader = new Reader(
      root,
      rawSource,
      memory,
      {
        get: async (key: string) => {
          const data = await io.shared.get(key);
          if (data && scope.getStore()) {
            const old = sharedTransfers.get(key) ?? { calls: 0, bytes: 0 };
            old.calls++;
            old.bytes += data.byteLength;
            sharedTransfers.set(key, old);
          }
          return data;
        },
        put: io.shared.put.bind(io.shared),
      },
      "candidate-amplification",
      (p: Promise<unknown>) => deferred.push(p),
    );
    reader.inspectCandidateBlocks = (
      blocks: Branch[][],
      mask: Uint8Array,
      first: number,
    ) => {
      const candidates: number[] = [];
      for (let i = 0; i < mask.length; i++)
        if (mask[i]) candidates.push(first + i);
      maskCandidates += candidates.length;
      for (const bs of blocks)
        for (const b of bs) {
          let lo = 0,
            hi = candidates.length;
          while (lo < hi) {
            const m = (lo + hi) >>> 1;
            if (candidates[m] < b.first) lo = m + 1;
            else hi = m;
          }
          const overlap = lo < candidates.length && candidates[lo] <= b.last,
            key = reader.key(b.score),
            old = refs.get(key);
          const matching = candidates.slice(lo).filter((doc) => doc <= b.last);
          if (old) {
            old.visits++;
            old.overlap ||= overlap;
            for (const doc of matching) old.candidates.add(doc);
          } else
            refs.set(key, {
              ref: b.score,
              overlap,
              visits: 1,
              candidates: new Set(matching),
            });
        }
    };
    const scores = reader.scores.bind(reader),
      prefetch = reader.prefetchScores.bind(reader);
    reader.scores = async (...args: [Ref[], boolean?]) => {
      for (const ref of args[0]) scheduled.add(reader.key(ref));
      const result = await scope.run(true, () => scores(...args));
      result.forEach((raw: Uint8Array, i: number) =>
        scoreData.set(raw, reader.key(args[0][i])),
      );
      return result;
    };
    reader.prefetchScores = (...args: [Ref[]]) => {
      for (const ref of args[0]) scheduled.add(reader.key(ref));
      return scope.run(true, () => prefetch(...args));
    };
    const before = { ...io.calls },
      append = ScoreBatch.prototype.append;
    ScoreBatch.prototype.append = function (raw: Uint8Array, block: number) {
      const key = scoreData.get(raw);
      if (!key) throw Error("Unattributed score decode");
      const old = decoded.get(key) ?? { count: 0, bytes: raw.length };
      old.count++;
      decoded.set(key, old);
      return append.call(this, raw, block);
    };
    let result;
    try {
      result = await index.search(s.q, reader, s.options);
    } finally {
      ScoreBatch.prototype.append = append;
    }
    await Promise.all(deferred);
    if (
      result.results.length !== s.oracle.length ||
      result.results.some(
        (h: any, i: number) =>
          h.id !== s.oracle[i].id ||
          Math.abs(h.score - s.oracle[i].score) >
            1e-11 * Math.max(1, Math.abs(s.oracle[i].score)),
      )
    )
      throw Error("Oracle mismatch " + s.q);
    const pages = new Set<string>(),
      minimumPages = new Set<string>();
    const diagnosticReader = new Reader(root, source);
    let overlapBlocks = 0,
      overlapBytes = 0,
      extraBlocks = 0,
      extraBytes = 0,
      blockVisits = 0,
      spanOnlyBlocks = 0,
      unscheduledBlocks = 0;
    for (const [
      key,
      { ref, overlap: spanOverlap, visits, candidates },
    ] of refs) {
      if (!scheduled.has(key)) {
        unscheduledBlocks++;
        continue;
      }
      // Outside query counters and timing: inspect actual posting IDs, rather
      // than mistaking a block's [first,last] span for exact overlap.
      const overlap =
        spanOverlap &&
        decodeScores(await diagnosticReader.read(ref)).docs.some((doc) =>
          candidates.has(doc),
        );
      if (spanOverlap && !overlap) spanOnlyBlocks++;
      blockVisits += visits;
      if (overlap) {
        overlapBlocks++;
        overlapBytes += ref[2];
      } else {
        extraBlocks++;
        extraBytes += ref[2];
      }
      for (
        let p = Math.floor(ref[1] / 262144);
        p <= Math.floor((ref[1] + ref[2] - 1) / 262144);
        p++
      ) {
        pages.add(ref[0] + ":" + p);
        if (overlap) minimumPages.add(ref[0] + ":" + p);
      }
    }
    return {
      q: s.q,
      resultCount: result.results.length,
      resultSha256: createHash("sha256")
        .update(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(result).filter(([k]) => k !== "diagnostics"),
            ),
          ),
        )
        .digest("hex"),
      maskCandidates,
      overlapBlocks,
      overlapBytes,
      extraBlocks,
      extraBytes,
      blockVisits,
      spanOnlyBlocks,
      unscheduledBlocks,
      scheduledBlocksOutsideCandidateHook: [...scheduled].filter(
        (key) => !refs.has(key),
      ).length,
      uniqueScoreBlocksDecoded: decoded.size,
      uniqueScoreBytesDecoded: [...decoded.values()].reduce(
        (n, d) => n + d.bytes,
        0,
      ),
      repeatedScoreBytesDecoded: [...decoded.values()].reduce(
        (n, d) => n + (d.count - 1) * d.bytes,
        0,
      ),
      scoreDecodeCalls: [...decoded.values()].reduce((n, d) => n + d.count, 0),
      selectedPageEnvelopeBytes: pages.size * 262144,
      minimumPageEnvelopeBytes: minimumPages.size * 262144,
      originScoreReadCalls: [...transfers.values()].reduce((a, b) => a + b, 0),
      originScoreBytes: [...transfers].reduce(
        (n, [key, calls]) => n + Number(key.split(":").at(-1)) * calls,
        0,
      ),
      uniqueOriginScoreReadCalls: transfers.size,
      sharedScoreTransfers: [...sharedTransfers.values()].reduce(
        (n, v) => n + v.calls,
        0,
      ),
      uniqueSharedScoreTransfers: sharedTransfers.size,
      sharedScoreBytes: [...sharedTransfers.values()].reduce(
        (n, v) => n + v.bytes,
        0,
      ),
      repeatedSharedScoreBytes: [...sharedTransfers.values()].reduce(
        (n, v) => n + ((v.calls - 1) * v.bytes) / v.calls,
        0,
      ),
      diagnostics: result.diagnostics,
      modeledIO: Object.fromEntries(
        Object.entries(io.calls).map(([k, v]) => [
          k,
          v - before[k as keyof typeof before],
        ]),
      ),
    };
  }
  await run();
  const r = await run();
  rows.push(r);
  console.log(label, JSON.stringify(r));
}
await writeFile(
  out + "/" + label + "-amplification.json",
  JSON.stringify(
    {
      label,
      source: originalSource,
      diagnosticHookAdded: process.env.CWS_INSTRUMENT_CONTROL === "1",
      sourceSearchSha256: createHash("sha256")
        .update(await readFile(originalSource + "/src/columnar/search.ts"))
        .digest("hex"),
      kind: "No artificial delays; Reader hook observes post-cell-filter block lists. Actual posting-ID overlap is checked separately outside query counters. Unique page envelopes are upper bounds, not transfers. Queries without a candidate mask have no overlap breakdown. No whole-corpus scan oracle.",
      rows,
      downloads: source.downloads,
    },
    null,
    2,
  ),
);
