import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { randomUUID, createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { benchmarkToken } from "./token.js";

const [url, indexDirectory, contractPath, output] = process.argv.slice(2);
if (!output) throw Error("Use URL INDEX_DIRECTORY QUERY_CONTRACT_GZ OUTPUT_GZ");
await mkdir(dirname(output), { recursive: true });
const root = JSON.parse(await readFile(indexDirectory + "/root.json", "utf8")),
  contractBytes = await readFile(contractPath),
  contract = JSON.parse(gunzipSync(contractBytes).toString()),
  token = await benchmarkToken(),
  health: any = await fetch(url + "/health").then((r) => r.json());
assert.deepEqual(
  [health.generation, health.documents, health.corpusHash],
  [root.generation, root.count, root.corpusHash],
);
// Only query definitions are reused: the old contract's results belong to a
// different corpus. Never treat those IDs, totals or scores as this oracle.
const scenarios = contract.scenarios.map((s: any, sid: number) => ({
    sid,
    q: s.q,
    kind: s.kind,
    options: {
      ...s.options,
      exactTotal: false,
      metadata: true,
      snippets: true,
    },
  })),
  sessions = Number(process.env.CWS_SESSIONS ?? 1),
  initialSeed = Number(process.env.CWS_SEED ?? 491732),
  startedAt = new Date().toISOString(),
  journal = output + ".jsonl",
  rows: any[] = [];
const reference = process.env.CWS_REFERENCE_RESULTS
  ? JSON.parse(
      gunzipSync(await readFile(process.env.CWS_REFERENCE_RESULTS)).toString(),
    )
  : undefined;
if (reference) assert.equal(reference.health.generation, root.generation);
assert(
  scenarios.every((s: any) => !s.options.after),
  "Rebuild pagination cursors for the new corpus",
);
let seed = initialSeed;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const jobs = Array.from({ length: sessions }, (_, session) =>
  scenarios.map((s: any) => ({ sid: s.sid, session, order: random() })),
)
  .flat()
  .sort((a, b) => a.order - b.order);
const provenance = {
  url,
  health,
  indexDirectory,
  contractPath,
  contractSha256: createHash("sha256").update(contractBytes).digest("hex"),
  startedAt,
  sessions,
  seed: initialSeed,
  scenarios,
  condition: "fresh shared-cache namespace and in-request application reset",
  exactTotal: false,
  repeatabilityReference: process.env.CWS_REFERENCE_RESULTS,
  notes: [
    "Complete response includes metadata and query-relevant snippets; response cache disabled.",
    "Unique namespace per request; opaque R2 backend caches are not controlled.",
    "Query definitions only are reused from the old corpus. This is not a before/after corpus comparison.",
    "One sequential client in the recorded region; scenario percentiles are not production traffic percentiles.",
  ],
};
await writeFile(journal, "");
for (const { sid, session } of jobs) {
  const s = scenarios[sid],
    requestId = randomUUID(),
    namespace = "fresh-" + randomUUID(),
    start = performance.now();
  let row: any;
  try {
    const response = await fetch(url + "/search?requestId=" + requestId, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        q: s.q,
        ...s.options,
        resetMemory: true,
        cacheNamespace: namespace,
      }),
      signal: AbortSignal.timeout(180000),
    });
    const body = await response.text();
    let result: any;
    try {
      result = JSON.parse(body);
    } catch {
      result = { error: body.slice(0, 1000) };
    }
    row = {
      sid,
      session,
      requestId,
      namespace,
      q: s.q,
      status: response.status,
      clientMs: performance.now() - start,
      bytes: Buffer.byteLength(body),
      result,
    };
    if (response.ok) {
      assert.equal(result.generation, root.generation);
      assert.equal(result.diagnostics.applicationReset, true);
      assert.equal(result.total, undefined);
      assert.equal(result.diagnostics.namespace, namespace);
      const previous = reference?.rows.find(
        (r: any) => r.sid === sid && r.status === 200 && !r.error,
      );
      if (previous) {
        assert.deepEqual(
          result.results.map(({ score: _score, ...h }: any) => h),
          previous.result.results.map(({ score: _score, ...h }: any) => h),
        );
        result.results.forEach((h: any, i: number) =>
          assert(
            Math.abs(h.score - previous.result.results[i].score) <=
              1e-10 * Math.max(1, Math.abs(h.score)),
          ),
        );
        row.repeatabilityChecked = true;
      }
      row.checksPassed = true;
    }
  } catch (error) {
    row = {
      ...row,
      sid,
      session,
      requestId,
      namespace,
      q: s.q,
      clientMs: performance.now() - start,
      error: String(error),
    };
  }
  rows.push(row);
  await appendFile(journal, JSON.stringify(row) + "\n");
  await writeFile(output, gzipSync(JSON.stringify({ ...provenance, rows })));
  console.log(
    rows.length,
    "/",
    jobs.length,
    "query",
    sid,
    "session",
    session,
    Math.round(row.clientMs) + "ms",
    row.status ?? row.error,
    "R2",
    row.result?.diagnostics?.requests,
  );
}
await writeFile(
  output,
  gzipSync(
    JSON.stringify({
      ...provenance,
      rows,
      completedAt: new Date().toISOString(),
    }),
  ),
);
