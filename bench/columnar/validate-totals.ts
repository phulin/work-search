import { readFile, writeFile } from "node:fs/promises";
import { benchmarkToken } from "./token.js";
import { TermDirectory } from "../../src/columnar/term-directory.js";
const [name, dir, oracleFile, out] = process.argv.slice(2);
if (!name || !dir || !oracleFile || !out)
  throw Error("Usage: validate-totals.ts WORKER PACKET_DIR ORACLE OUTPUT");
const oracle = JSON.parse(await readFile(oracleFile, "utf8")),
  root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  directory = new TermDirectory(
    await readFile(dir + "/directory.bin"),
    root.count,
  ),
  token = await benchmarkToken(),
  rows = [];
const cases = oracle.scenarios
    .filter(
      (s: any) =>
        !s.options?.after && s.oracle.length < (s.options?.limit ?? 20),
    )
    .map((s: any) => ({ ...s, total: s.oracle.length })),
  court = (await directory.lookup(["court"])).get("court")!;
cases.push(
  { q: "court", total: court.df },
  { q: "NOT court", total: root.count - court.df },
);
for (const test of cases) {
  const start = performance.now(),
    r = await fetch(`https://${name}.phulin.workers.dev/search`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ q: test.q, ...test.options, exactTotal: true }),
    }),
    body = (await r.json()) as any;
  const correct =
    r.ok &&
    body.total === test.total &&
    (!test.oracle ||
      JSON.stringify(body.results.map((h: any) => h.id)) ===
        JSON.stringify(test.oracle.map((h: any) => h.id)));
  rows.push({
    q: test.q,
    options: test.options,
    expectedTotal: test.total,
    total: body.total,
    correct,
    status: r.status,
    ms: performance.now() - start,
    telemetry: body.telemetry,
    diagnostics: body.diagnostics,
  });
  await writeFile(
    out,
    JSON.stringify(
      {
        name,
        generation: root.generation,
        corpusHash: root.corpusHash,
        at: new Date().toISOString(),
        notes: [
          "Underfilled reference heaps were produced by a complete independent corpus scan; fewer than K results establish the exact total.",
          "The two court/complement totals additionally use directory DF; the source oracle independently verified query DFs.",
        ],
        rows,
      },
      null,
      2,
    ),
  );
  if (!correct)
    throw Error("Live total mismatch " + test.q + ": " + JSON.stringify(body));
}
console.log({ cases: rows.length, correct: rows.every((r) => r.correct) });
