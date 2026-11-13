import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { parallel } from "../src/storage/types.js";
import { demoWorkload } from "./demo-workload.js";
import { globalQueries } from "./global-workload.js";
const token = JSON.parse(
    await readFile("work/full-flp/secrets.json", "utf8"),
  ).INTERNAL_TOKEN,
  oracle = JSON.parse(
    await readFile("work/global-bench/competitive-oracle.json", "utf8"),
  ),
  variants = (
    process.env.GLOBAL_NATIVE_VARIANTS ??
    "work-search-global-control,work-search-global-competitive"
  ).split(","),
  queries = [
    ...demoWorkload,
    ...globalQueries.filter((q) => !demoWorkload.some((p) => p.q === q.q)),
  ],
  db = new DatabaseSync("work/global-100k/terms.sqlite", { readOnly: true }),
  terms = db
    .prepare(
      "SELECT term FROM micro WHERE term<>'' ORDER BY df DESC,sort LIMIT 64",
    )
    .all()
    .map((r) => String(r.term)),
  rows: any[] = [],
  warmup: any[] = [];
db.close();
async function call(name: string, path: string, body?: any) {
  const start = performance.now(),
    r = await fetch(
      `https://${name}.phulin.workers.dev${path}${body?.q ? "?q=" + encodeURIComponent(body.q) : ""}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    ),
    text = await r.text();
  if (!r.ok) throw Error(name + " " + r.status + " " + text);
  return {
    result: path === "/__reset" ? undefined : JSON.parse(text),
    ms: performance.now() - start,
  };
}
for (const name of variants) {
  const h = await call(name, "/health");
  if (
    (h.result.engine !== "legacy" && h.result.documents !== 100000) ||
    (h.result.readPageBytes !== undefined && h.result.readPageBytes !== 262144)
  )
    throw Error("Native configuration mismatch");
  await parallel(terms, 3, async (term) => {
    const r = await call(
      name,
      name.endsWith("-old") ? "/warm-term" : "/search",
      name.endsWith("-old")
        ? { term }
        : {
            q: JSON.stringify(term),
            limit: 100,
            metadata: false,
            snippets: false,
          },
    );
    if (r.result.results.length !== 100) throw Error("Incomplete index prime");
    warmup.push({ name, term, ms: r.ms });
  });
}
for (let pass = 0; pass < 2; pass++)
  for (const [qi, q] of queries.entries()) {
    for (const name of (pass + qi) % 2 ? [...variants].reverse() : variants) {
      const { result, ms } = await call(name, "/search", {
          q: q.q,
          limit: 20,
          resetMemory: true,
        }),
        want = oracle[q.q];
      if (
        result.results.length !== want.length ||
        result.results.some(
          (h: any, i: number) =>
            h.id !== want[i].id ||
            Math.abs(h.score - want[i].score) >
              1e-11 * Math.max(1, Math.abs(want[i].score)) ||
            JSON.stringify([h.title, h.metadata]) !==
              JSON.stringify([want[i].title, want[i].metadata]),
        )
      )
        throw Error("Native verification mismatch " + q.q);
      rows.push({
        name,
        ...q,
        group: qi < demoWorkload.length ? "legal" : "stress",
        pass,
        ms,
        diagnostics: result.diagnostics,
        colo: result.colo,
      });
      console.log(
        pass,
        name,
        q.q,
        Math.round(ms),
        result.diagnostics.requests,
        result.diagnostics.verifiedDocuments,
      );
      await writeFile(
        "work/global-bench/" +
          (process.env.GLOBAL_NATIVE_LABEL ?? "native-competitive") +
          ".json",
        JSON.stringify({
          kind:
            process.env.GLOBAL_NATIVE_DESCRIPTION ??
            "Fresh Worker/cache namespaces, identical corpus-frequency ID-only prime, interleaved cold-memory legal/stress queries then repeated queries, no response cache",
          variants,
          rows,
          warmup,
        }),
      );
    }
  }
