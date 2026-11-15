import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
const output = "bench/results/columnar/phrase-planner-1m",
  data = JSON.parse(await readFile(output + "/wide-empty.json", "utf8")),
  tail = data.queries
    .slice()
    .sort((a: any, b: any) => b.after.wallMs.median - a.after.wallMs.median)
    .slice(0, 20),
  contracts = JSON.parse(
    gunzipSync(
      await readFile(output + "/expanded-200-contract.json.gz"),
    ).toString(),
  ),
  profileDir = "work/phrase-planner-tail-profiles";
if (process.argv[2] === "select") {
  const selected = {
    ...contracts,
    selection: {
      criterion:
        "20 slowest candidate query medians in the completed cold all-totals-off 200-query run",
      implementationSha256: data.manifest.implementationSha256,
    },
    scenarios: tail.map((q: any) => {
      const matches = contracts.scenarios.filter((s: any) => s.q === q.q);
      if (matches.length !== 1 || matches[0].options.exactTotal !== false)
        throw Error("Ambiguous tail selection");
      return matches[0];
    }),
  };
  await writeFile(
    "work/phrase-planner-tail-contract.json",
    JSON.stringify(selected),
  );
  await writeFile(
    output + "/tail-contract.json.gz",
    gzipSync(JSON.stringify(selected)),
  );
  for (const [i, q] of tail.entries())
    console.log(i + 1, Math.round(q.after.wallMs.median), q.q);
  process.exit(0);
}
const profile = JSON.parse(
  await readFile(profileDir + "/summary.json", "utf8"),
);
if (profile.cacheCondition !== "fresh-namespace" || profile.rows.length !== 20)
  throw Error("Expected 20 cold profiles");
const median = (a: number[]) => a.slice().sort((a, b) => a - b)[a.length >> 1];
// Inspector setup/idle and unattributed V8 program samples are not engine CPU.
// Keep their weight visible without putting them in engine category shares.
const excludedSample = (key: string) =>
  /\((idle|program|root)\)|node:inspector/.test(key);
const category = (key: string) =>
  key.includes("(garbage collector)")
    ? "GC"
    : /columnar\/(format|compact-integers)/.test(key)
      ? "integer/column decoding"
      : /query\/evaluate/.test(key)
        ? "Boolean/proximity evaluation"
        : /columnar\/(score|scoring|maxscore|top-k)/.test(key)
          ? "scoring/pruning"
          : /columnar\/(exact-phrase|pair-|positions|forward)/.test(key)
            ? "phrase/membership/positions"
            : /columnar\/(document-package|document-directory)/.test(key)
              ? "document verification/presentation"
              : /columnar\/(term-directory|term-shard|dictionary)/.test(key)
                ? "term directory"
                : /columnar\/(storage|local-storage|latency-model)|MIME|Response|Headers|Stream/.test(
                      key,
                    )
                  ? "storage/cache/streams"
                  : /columnar\/search/.test(key)
                    ? "execution loops"
                    : "runtime/other";
const rows = tail.map((q: any, rank: number) => {
  const p = profile.rows.find((p: any) => p.q === q.q);
  if (!p || !p.ioTrace || p.options.exactTotal !== false)
    throw Error("Missing cold trace: " + q.q);
  const functions = Object.entries(p.selfMicros).filter(
      ([key]) => !excludedSample(key),
    ),
    excludedSelfMicros = Object.entries(p.selfMicros).reduce(
      (n, [key, us]) => n + (excludedSample(key) ? (us as number) : 0),
      0,
    ),
    groups: Record<string, number> = {},
    total = functions.reduce((n, [, us]) => n + (us as number), 0);
  for (const [key, us] of functions)
    groups[category(key)] = (groups[category(key)] ?? 0) + (us as number);
  const cpuGroups = Object.fromEntries(
    Object.entries(groups)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [
        k,
        { selfMs: v / 1000, selfPercent: (100 * v) / total },
      ]),
  );
  return {
    rank: rank + 1,
    q: q.q,
    options: q.options,
    coldMs: q.after.wallMs,
    coldCpuMs: q.after.cpuMs,
    diagnostics: q.after.counters,
    executors: q.after.executors,
    sampledCpuCallMedianMs: median(p.calls.map((c: any) => c.cpuMs)),
    excludedSelfMicros,
    cpuGroups,
    sampledAllocationBytesAcrossThreeCalls: Object.values(
      p.sampledAllocationBytes,
    ).reduce((n: any, v: any) => n + v, 0),
    topSelfFunctions: functions.slice(0, 12),
    ioTrace: p.ioTrace,
  };
});
await writeFile(
  output + "/tail-summary.json",
  JSON.stringify(
    {
      note: "Selected by completed three-repeat cold medians, all exact totals off. CPU sampling uses eight calls per query with empty application/shared caches and artificial delays disabled; allocation sampling uses three further calls. CPU selfPercent excludes idle, program, root and inspector samples; remaining runtime/model overhead is included. These are sample distributions, not shares of cold request latency. One separate instrumented 20ms/100MiBps cold trace per query. Interval categories overlap; CPU overlaps I/O. Native Worker memory and CPU are not measured.",
      generation: profile.generation,
      exactPhraseSha256: profile.exactPhraseSha256,
      searchSha256: profile.searchSha256,
      rows,
    },
    null,
    2,
  ) + "\n",
);
await mkdir(output + "/profiles/tail", { recursive: true });
for (const name of await readdir(profileDir)) {
  const b = await readFile(profileDir + "/" + name);
  await writeFile(
    output + "/profiles/tail/" + (name.endsWith(".gz") ? name : name + ".gz"),
    name.endsWith(".gz") ? b : gzipSync(b),
  );
}
for (const r of rows)
  console.log(
    JSON.stringify({
      rank: r.rank,
      q: r.q,
      ms: r.coldMs.median,
      cpu: r.sampledCpuCallMedianMs,
      groups: r.cpuGroups,
      io: r.ioTrace.phases,
    }),
  );
