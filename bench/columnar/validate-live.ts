import { readFile, writeFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { benchmarkToken } from "./token.js";
const [url, oraclePath, output] = process.argv.slice(2);
if (!output) throw Error("Use URL ORACLE_JSON OUTPUT_JSON");
const oracle = JSON.parse(await readFile(oraclePath, "utf8")),
  token = await benchmarkToken(),
  health: any = await fetch(url + "/health").then((r) => r.json()),
  previous = JSON.parse(await readFile(output, "utf8").catch(() => "null")),
  rows: any[] = previous?.rows ?? [];
assert.deepEqual(
  [health.generation, health.corpusHash, health.documents],
  [oracle.generation, oracle.corpusHash, oracle.count],
);
if (previous) {
  assert.equal(previous.health.generation, oracle.generation);
  assert(
    rows.every(
      (r, i) => r.sid === i && r.q === oracle.scenarios[i].q && r.passed,
    ),
  );
}
let maxRelativeScoreDifference = previous?.maxRelativeScoreDifference ?? 0;
for (const [sid, scenario] of oracle.scenarios.entries()) {
  if (sid < rows.length) continue;
  const requestId = randomUUID(),
    response = await fetch(url + "/search?requestId=" + requestId, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        q: scenario.q,
        ...scenario.options,
        generation: oracle.generation,
        exactTotal: false,
        metadata: true,
        snippets: true,
        resetMemory: true,
        cacheNamespace: "validate-" + randomUUID(),
      }),
      signal: AbortSignal.timeout(180000),
    }),
    actual: any = await response.json();
  assert.equal(response.status, 200, scenario.q + ": " + actual.error);
  assert.equal(actual.generation, oracle.generation);
  assert.deepEqual(
    actual.results.map((h: any) => [h.doc, h.id, h.title, h.metadata]),
    scenario.oracle.map((h: any) => [h.doc, h.id, h.title, h.metadata]),
    scenario.q,
  );
  for (let i = 0; i < actual.results.length; i++) {
    const error =
      Math.abs(actual.results[i].score - scenario.oracle[i].score) /
      Math.max(1, Math.abs(scenario.oracle[i].score));
    assert(error <= 1e-11, scenario.q + " score");
    maxRelativeScoreDifference = Math.max(maxRelativeScoreDifference, error);
  }
  rows.push({
    sid,
    q: scenario.q,
    results: actual.results.length,
    requestId,
    passed: true,
  });
  await writeFile(
    output,
    JSON.stringify(
      {
        health,
        oraclePath,
        independentDfVerified: oracle.independentDfVerified,
        independentGlobalStatsVerified: oracle.independentGlobalStatsVerified,
        queries: rows.length,
        maxRelativeScoreDifference,
        rows,
      },
      null,
      2,
    ),
  );
  console.log(
    "Validated",
    rows.length,
    "/",
    oracle.scenarios.length,
    scenario.q,
  );
}
