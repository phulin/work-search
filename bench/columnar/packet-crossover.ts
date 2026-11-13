import { readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { benchmarkToken } from "./token.js";
const name = process.env.CWS_VARIANTS ?? "work-search-cws-near",
  label = process.env.CWS_LABEL ?? "packet-crossover",
  scenarios = JSON.parse(await readFile(process.env.CWS_SCENARIOS!, "utf8")),
  repeats = Number(process.env.CWS_REPEATS ?? 3),
  plans = (process.env.CWS_PLANS ?? "complete-terms,documents").split(","),
  readModes = (process.env.CWS_READ_MODES ?? "coalesced").split(","),
  token = await benchmarkToken(),
  rows: any[] = [],
  health = (await fetch(`https://${name}.phulin.workers.dev/health`).then((r) =>
    r.json(),
  )) as any;
if (
  health.corpusHash !== scenarios.corpusHash ||
  health.documents !== scenarios.count
)
  throw Error("Crossover corpus mismatch");
let seed = 20261113;
function rand() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 2 ** 32;
}
function shuffle<T>(a: T[]) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const manifest = {
  name,
  generation: health.generation,
  corpusHash: health.corpusHash,
  documents: health.documents,
  repeats,
  seed,
  condition: process.env.CWS_CONDITION ?? "memory-reuse",
  startedAt: new Date().toISOString(),
  clientRegion: "local-New-England",
  responseCaching: false,
  plans,
  readModes,
};
const save = () =>
  writeFile(
    `work/columnar-bench/${label}.json.gz`,
    gzipSync(JSON.stringify({ manifest, rows })),
  );
for (let repeat = 0; repeat < repeats; repeat++) {
  for (const scenario of shuffle<any>(
    scenarios.scenarios.filter((s: any) => !s.options?.after),
  )) {
    for (const { plan, readMode } of shuffle(
      plans.flatMap((plan) =>
        readModes.map((readMode) => ({ plan, readMode })),
      ),
    )) {
      const requestId = randomUUID(),
        started = performance.now();
      let row: any = {
        name,
        plan: readModes.length > 1 ? `${plan}:${readMode}` : plan,
        strategy: plan,
        readMode,
        q: scenario.q,
        kind: scenario.kind,
        options: scenario.options,
        repeat,
        requestId,
      };
      try {
        const response = await fetch(
            `https://${name}.phulin.workers.dev/__benchmark/plan/${plan}?requestId=${requestId}`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                q: scenario.q,
                ...scenario.options,
                resetMemory: manifest.condition !== "memory-reuse",
                cacheNamespace:
                  manifest.condition === "fresh-namespace"
                    ? "transfer-" + requestId
                    : undefined,
                pageTransfers: readMode === "pages",
              }),
              signal: AbortSignal.timeout(120000),
            },
          ),
          text = await response.text(),
          body = JSON.parse(text);
        row = {
          ...row,
          ms: performance.now() - started,
          status: response.status,
          bytes: text.length,
          diagnostics: body.diagnostics,
          telemetry: body.telemetry,
          colo: body.colo,
        };
        if (response.status === 422 && body.unsupported) row.unsupported = true;
        else {
          if (!response.ok) throw Error(text.slice(0, 1000));
          const want = scenario.oracle;
          if (
            body.results.length !== want.length ||
            body.results.some(
              (h: any, i: number) =>
                h.id !== want[i].id ||
                Math.abs(h.score - want[i].score) >
                  1e-11 * Math.max(1, Math.abs(want[i].score)) ||
                JSON.stringify([h.title, h.metadata]) !==
                  JSON.stringify([want[i].title, want[i].metadata]) ||
                typeof h.snippet !== "string",
            )
          )
            throw Error("Independent oracle mismatch");
        }
      } catch (error) {
        row.error = String(error);
        row.ms = performance.now() - started;
      }
      rows.push(row);
      if (row.error)
        console.log("Crossover error", plan, scenario.q, row.error);
    }
    await save();
  }
  console.log("Crossover repeat", repeat + 1, rows.length, "responses");
}
await save();
const quantiles = (a: number[]) => {
  a.sort((a, b) => a - b);
  return {
    n: a.length,
    p50: a[Math.ceil(a.length * 0.5) - 1],
    p95: a[Math.ceil(a.length * 0.95) - 1],
    p99: a[Math.ceil(a.length * 0.99) - 1],
  };
};
console.log(
  Object.fromEntries(
    [...new Set(rows.map((r) => r.plan))].map((plan) => {
      const all = rows.filter((r) => r.plan === plan);
      return [
        plan,
        {
          ...quantiles(
            all.filter((r) => !r.error && !r.unsupported).map((r) => r.ms),
          ),
          unsupported: all.filter((r) => r.unsupported).length,
          errors: all.filter((r) => r.error).length,
        },
      ];
    }),
  ),
);
