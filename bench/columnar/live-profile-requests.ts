import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { strict as assert } from "node:assert";
import { benchmarkToken } from "./token.js";
const [url, out] = process.argv.slice(2);
if (!out) throw Error("Use URL OUTPUT.json");
await mkdir(dirname(out), { recursive: true });
const contract = JSON.parse(
  await readFile("bench/results/columnar/deployment-1m/contract.json", "utf8"),
);
const token = await benchmarkToken(),
  health: any = await fetch(url + "/health").then((r) => r.json());
assert.equal(health.generation, contract.generation);
assert.equal(health.documents, 1000000);
const selected = (process.env.CWS_SCENARIOS ?? "8,2,4,5")
    .split(",")
    .map(Number),
  rows: any[] = [];
let seed = 834021;
const rand = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const sessions = Number(process.env.CWS_SESSIONS ?? 3),
  conditions = [
    "fresh-namespace-application-reset",
    "immediate-repeat",
    "shared-reuse-application-reset",
  ];
async function call(
  sid: number,
  session: number,
  condition: string,
  namespace: string,
) {
  const s = contract.scenarios[sid],
    requestId = randomUUID(),
    start = performance.now();
  const response = await fetch(url + "/search?requestId=" + requestId, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(process.env.CWS_SHARED_BUDGET
        ? { "x-profile-shared-budget": process.env.CWS_SHARED_BUDGET }
        : {}),
    },
    body: JSON.stringify({
      q: s.q,
      ...s.options,
      metadata: true,
      snippets: true,
      cacheNamespace: namespace,
      resetMemory: condition !== "immediate-repeat",
    }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await response.text(),
    ms = performance.now() - start;
  let result: any;
  try {
    result = JSON.parse(body);
  } catch {
    result = { error: body.slice(0, 1000) };
  }
  rows.push({
    sid,
    session,
    condition,
    namespace,
    requestId,
    q: s.q,
    status: response.status,
    clientMs: ms,
    bytes: Buffer.byteLength(body),
    result,
  });
  await writeFile(
    out,
    JSON.stringify(
      {
        url,
        health,
        seed: 834021,
        sessions,
        sharedBudgetOverride: process.env.CWS_SHARED_BUDGET,
        selected,
        startedAt,
        conditions,
        notes: [
          "No response caching. Application reset is in the search request. Fresh namespaces empty Cloudflare application page-cache identity, not opaque R2 backend caches. Conditions within each query are sequenced to establish cache state; query/session order is randomized.",
        ],
        rows,
      },
      null,
      2,
    ),
  );
  assert.equal(response.status, 200, result.error);
  assert.equal(result.generation, contract.generation);
  assert.deepEqual(
    result.results.map((h: any) => h.id),
    s.oracle.map((h: any) => h.id),
  );
  result.results.forEach((h: any, i: number) => {
    const w = s.oracle[i];
    assert(
      Math.abs(h.score - w.score) <= 1e-8 * Math.max(1, Math.abs(w.score)),
    );
    assert.deepEqual(
      [h.title, h.metadata, h.snippet],
      [w.title, w.metadata, w.snippet],
    );
  });
  if (s.options.exactTotal) assert.equal(result.total, s.total);
  console.log(
    session,
    sid,
    condition,
    Math.round(ms) + "ms",
    "R2",
    result.diagnostics?.requests,
    "shared",
    result.diagnostics?.sharedGets,
    "isolate",
    result.telemetry?.isolate?.slice(0, 8),
  );
}
const startedAt = new Date().toISOString();
const jobs = Array.from({ length: sessions }, (_, session) =>
  selected.map((sid) => ({ session, sid, order: rand() })),
)
  .flat()
  .sort((a, b) => a.order - b.order);
for (const { session, sid } of jobs) {
  const namespace = "profile-" + randomUUID();
  for (const condition of conditions)
    await call(sid, session, condition, namespace);
}
const saved = JSON.parse(await readFile(out, "utf8"));
await writeFile(
  out,
  JSON.stringify(
    { ...saved, completedAt: new Date().toISOString(), allChecksPassed: true },
    null,
    2,
  ),
);
