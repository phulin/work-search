import { readFile, writeFile, appendFile } from "node:fs/promises";
import gateway from "../demo/gateway.js";
import { context, tracedBucket } from "./demo-trace.js";
import { EmpiricalModel, Slots } from "./demo-model.js";
import { root } from "./demo-client.js";
import { demoWorkload } from "./demo-workload.js";
import { createDemoGraph, type LocalTrace } from "./demo-graph.js";
const hydrate = process.argv.includes("--hydrate");
const {
  env,
  runtimes,
  calibration,
  bucket: originalBucket,
} = await createDemoGraph(hydrate);
const queries = process.env.DEMO_QUERIES
  ? demoWorkload.slice(0, Number(process.env.DEMO_QUERIES))
  : demoWorkload;
const live = JSON.parse(await readFile(root + "/live.json", "utf8"));
const expected = new Map(
  live.rows
    .filter((r: any) => r.pass === 0 && !r.page)
    .map((r: any) => [
      r.q,
      r.body.results.map((h: any) => ({ id: h.id, score: h.score })),
    ]),
);
const modes = hydrate
  ? ["none"]
  : (process.env.DEMO_MODES ?? "none,fixed20,empirical").split(",");
const rows: any[] = [];
const output =
  root +
  (hydrate ? "/hydrate.json" : `/${process.env.DEMO_OUTPUT ?? "local"}.json`);
await writeFile(output + "l", "");
for (const mode of modes)
  for (const phase of (process.env.DEMO_PHASES ?? "reset,mixed,repeat").split(
    ",",
  )) {
    for (const runtime of runtimes) runtime.clear();
    // Rebuild root cache per scenario while preserving it across its mixed stream.
    const scenarioBucket = new Proxy(originalBucket, {});
    env.INDEX = tracedBucket(scenarioBucket);
    const repeats =
      phase === "repeat" ? Number(process.env.DEMO_REPEATS ?? 3) : 1;
    for (let pass = 0; pass < repeats; pass++)
      for (const [qi, q] of queries.entries()) {
        if (phase === "reset") {
          for (const runtime of runtimes) runtime.clear();
          env.INDEX = tracedBucket(new Proxy(originalBucket, {}));
        }
        const trace: LocalTrace = {
          start: performance.now(),
          events: [],
          slots: new Slots(6),
          model: new EmpiricalModel(
            calibration.rows,
            20261111 + qi + pass * 4099,
            (mode.startsWith("empirical") ? "empirical" : mode) as any,
            mode === "empirical-repeated" ? "repeated-range" : "varied-range",
          ),
          diagnostics: [],
        };
        const cpu = process.cpuUsage(),
          start = performance.now();
        const response = await context.run(trace, () =>
          gateway.fetch(
            new Request("https://local/api/search", {
              method: "POST",
              body: JSON.stringify({ q: q.q, limit: 20 }),
            }),
            env,
          ),
        );
        const body: any = await response.json(),
          ms = performance.now() - start,
          used = process.cpuUsage(cpu);
        if (!response.ok) throw Error(JSON.stringify(body));
        const got = body.results.map((h: any) => ({
            id: h.id,
            score: h.score,
          })),
          want: any = expected.get(q.q);
        if (
          !want ||
          got.length !== want.length ||
          got.some(
            (h: any, i: number) =>
              h.id !== want[i].id ||
              Math.abs(h.score - want[i].score) >
                1e-11 * Math.max(1, Math.abs(h.score)),
          )
        )
          throw Error("Local/live ranking mismatch: " + q.q);
        if (Number(process.env.DEMO_OPT_STAGE ?? 0) >= 1) {
          const reference = live.rows.find(
            (r: any) => r.q === q.q && r.pass === 0 && !r.page,
          ).body.results;
          for (let i = 0; i < body.results.length; i++) {
            const fields = (h: any) =>
              JSON.stringify([
                h.title,
                h.metadata?.court,
                h.metadata?.date_filed,
                h.metadata?.docket_number,
                h.metadata?.citations,
              ]);
            if (fields(body.results[i]) !== fields(reference[i]))
              throw Error("Result-card metadata mismatch: " + q.q);
          }
        }
        rows.push({
          ...q,
          mode,
          phase,
          pass,
          ms,
          cpuMs: (used.user + used.system) / 1000,
          rss: process.memoryUsage().rss,
          results: got,
          trace: { events: trace.events, diagnostics: trace.diagnostics },
        });
        console.log(
          hydrate ? "Hydrated" : "Measured",
          mode,
          phase,
          pass,
          q.q,
          ms.toFixed(1),
        );
        await appendFile(output + "l", JSON.stringify(rows.at(-1)) + "\n");
      }
  }

await writeFile(
  output,
  JSON.stringify(
    {
      kind: "Local production gateway and shard code with frozen bundles, mirrored bytes and empirical R2; not deployed latency",
      node: process.version,
      complete: true,
      rows,
    },
    null,
    2,
  ),
);
