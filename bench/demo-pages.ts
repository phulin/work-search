import { readFile, writeFile } from "node:fs/promises";
import gateway from "../demo/gateway.js";
import { createDemoGraph, type LocalTrace } from "./demo-graph.js";
import { root } from "./demo-client.js";
import { context, tracedBucket } from "./demo-trace.js";
import { EmpiricalModel, Slots } from "./demo-model.js";
const hydrate = process.argv.includes("--hydrate"),
  { env, runtimes, calibration, bucket } = await createDemoGraph(hydrate);
const live = JSON.parse(await readFile(root + "/live.json", "utf8")).rows;
const queries = [
  ...new Set<string>(
    live.filter((r: any) => r.page === 2).map((r: any) => r.q),
  ),
];
const rows: any[] = [];
for (const mode of hydrate
  ? ["none"]
  : ["fixed20", "empirical", "empirical-repeated"]) {
  for (const runtime of runtimes) runtime.clear();
  env.INDEX = tracedBucket(new Proxy(bucket, {}));
  for (const [qi, q] of queries.entries()) {
    let cursor: string | undefined;
    for (const page of [1, 2]) {
      const trace: LocalTrace = {
        start: performance.now(),
        events: [],
        slots: new Slots(6),
        model: new EmpiricalModel(
          calibration.rows,
          20261111 + qi + page * 1021,
          mode === "fixed20"
            ? "fixed20"
            : mode === "none"
              ? "none"
              : "empirical",
          mode === "empirical-repeated" ? "repeated-range" : "varied-range",
        ),
        diagnostics: [],
      };
      const start = performance.now(),
        cpu = process.cpuUsage();
      const response = await context.run(trace, () =>
        gateway.fetch(
          new Request("https://local/api/search", {
            method: "POST",
            body: JSON.stringify({ q, limit: 20, cursor }),
          }),
          env,
        ),
      );
      const body: any = await response.json(),
        ms = performance.now() - start,
        used = process.cpuUsage(cpu);
      if (!response.ok) throw Error(JSON.stringify(body));
      const expected = live.find(
        (r: any) => r.q === q && r.pass === 0 && (r.page ?? 1) === page,
      ).body.results;
      if (
        expected.length !== body.results.length ||
        body.results.some(
          (h: any, i: number) =>
            h.id !== expected[i].id ||
            Math.abs(h.score - expected[i].score) >
              1e-11 * Math.max(1, Math.abs(h.score)),
        )
      )
        throw Error("Pagination ranking mismatch");
      cursor = body.nextCursor;
      rows.push({
        q,
        page,
        mode,
        phase: "page-sequence",
        ms,
        cpuMs: (used.user + used.system) / 1000,
        rss: process.memoryUsage().rss,
        trace: { events: trace.events, diagnostics: trace.diagnostics },
      });
      await writeFile(
        root + (hydrate ? "/pages-hydrate.json" : "/pages.json"),
        JSON.stringify({ rows }, null, 2),
      );
      console.log(
        hydrate ? "Hydrated page" : "Measured page",
        q,
        page,
        mode,
        ms.toFixed(1),
      );
    }
  }
}
