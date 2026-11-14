/** Interleaved complete responses on two immutable-runtime benchmark Workers. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { strict as assert } from "node:assert";
import { benchmarkToken } from "./token.js";
const [before, after, contractPath, output] = process.argv.slice(2);
const requestTimeoutMs = Number(process.env.CWS_REQUEST_TIMEOUT_MS ?? 60000);
if (
  !Number.isFinite(requestTimeoutMs) ||
  requestTimeoutMs < 1000 ||
  requestTimeoutMs > 300000
)
  throw Error("Request timeout must be between 1 and 300 seconds");
if (!output)
  throw Error(
    "Usage: io-live.ts CONTROL_URL CANDIDATE_URL CONTRACT OUTPUT.json.gz",
  );
await mkdir(dirname(output), { recursive: true });
const contractBytes = await readFile(contractPath),
  contract = JSON.parse(contractBytes.toString()),
  token = await benchmarkToken(),
  urls = { control: before, candidate: after },
  rows: any[] = [],
  health = Object.fromEntries(
    await Promise.all(
      Object.entries(urls).map(async ([v, u]) => [
        v,
        await fetch(u + "/health").then((r) => r.json()),
      ]),
    ),
  );
for (const [variant, h] of Object.entries(health) as [string, any][]) {
  assert.equal(
    h.generation,
    contract.generations?.[variant] ?? contract.generation,
  );
  assert.equal(h.documents, 1000000);
  assert.equal(h.corpusHash, contract.corpusHash);
  assert.equal(h.analysis, contract.analysis);
  if (contract.metadataGenerations)
    assert.equal(h.metadataGeneration, contract.metadataGenerations[variant]);
  if (contract.exactPhraseGenerations)
    assert.equal(
      h.exactPhraseGeneration,
      contract.exactPhraseGenerations[variant],
    );
}
let seed = 20261114;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};
const shuffled = <T>(xs: T[]) =>
  xs
    .map((x) => ({ x, r: random() }))
    .sort((a, b) => a.r - b.r)
    .map((o) => o.x);
const manifest = {
  kind: "Live complete-response comparison; no response caching",
  startedAt: new Date().toISOString(),
  contractPath,
  contractSha256: createHash("sha256").update(contractBytes).digest("hex"),
  urls,
  health,
  seed,
  requestTimeoutMs,
  completedAt: undefined as string | undefined,
  notes: [
    "Fresh application and shared namespaces per query/session/variant. Shared-warm requests reset application memory in the request; immediate-repeat and load requests permit reuse, with actual isolate IDs recorded. Opaque R2 caches uncontrolled.",
    "Query/session and variant order randomized. Three diagnostic samples per query/condition, not traffic percentiles.",
  ],
};
const save = () =>
  writeFile(output, gzipSync(JSON.stringify({ manifest, rows })));
async function request(
  variant: keyof typeof urls,
  s: any,
  condition: string,
  session: number,
  namespace: string,
  extra: any = {},
) {
  const requestId = randomUUID(),
    start = performance.now();
  let r: Response, body: string;
  try {
    r = await fetch(urls[variant] + "/search?requestId=" + requestId, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        q: s.q,
        ...(s.optionsByVariant?.[variant] ?? s.options),
        metadata: true,
        snippets: true,
        cacheNamespace: namespace,
        resetMemory: !["immediate-repeat", "load"].includes(condition),
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    body = await r.text();
  } catch (error) {
    rows.push({
      variant,
      q: s.q,
      options: s.options,
      kind: s.kind,
      condition,
      session,
      namespace,
      requestId,
      clientMs: performance.now() - start,
      status: 0,
      error: String(error),
      cause: String((error as any)?.cause ?? ""),
      ...extra,
    });
    console.error("Transport failure", variant, requestId, String(error));
    throw error;
  }
  const clientMs = performance.now() - start;
  let result: any;
  try {
    result = JSON.parse(body);
  } catch {
    result = { error: "Non-JSON response", body: body.slice(0, 1000) };
  }
  const row = {
    variant,
    q: s.q,
    options: s.options,
    kind: s.kind,
    condition,
    session,
    namespace,
    requestId,
    clientMs,
    status: r.status,
    bytes: Buffer.byteLength(body),
    result,
    ray: r.headers.get("cf-ray"),
    ...extra,
  };
  rows.push(row);
  assert.equal(r.status, 200, result.error);
  assert.equal(result.generation, (health as any)[variant].generation);
  const oracle = s.oracleByVariant?.[variant] ?? s.oracle;
  assert.deepEqual(
    result.results.map((h: any) => h.id),
    oracle.map((h: any) => h.id),
  );
  result.results.forEach((h: any, i: number) => {
    const w = oracle[i];
    assert(
      Math.abs(h.score - w.score) <= 1e-8 * Math.max(1, Math.abs(w.score)),
    );
    assert.deepEqual(
      [h.title, h.metadata, h.snippet],
      [w.title, w.metadata, w.snippet],
    );
  });
  if (s.options.exactTotal) assert.equal(result.total, s.total);
  Object.assign(row, { correct: true });
  console.log(
    variant,
    condition,
    Math.round(clientMs) + "ms",
    result.diagnostics.requests,
    "R2",
    s.q,
  );
  return row;
}
const selected = contract.scenarios.filter(
    (s: any) =>
      !process.env.CWS_QUERY_FILTER ||
      s.q.includes(process.env.CWS_QUERY_FILTER),
  ),
  repeats = Number(process.env.CWS_REPEATS ?? 3),
  jobs = shuffled(
    Array.from({ length: repeats }, (_, session) =>
      selected.map((s: any) => ({ s, session })),
    ).flat(),
  );
for (const { s, session } of jobs) {
  const namespaces = {
    control: "io-" + randomUUID(),
    candidate: "io-" + randomUUID(),
  };
  for (const condition of [
    "fresh-namespace",
    ...(process.env.CWS_REUSE === "1" ? ["immediate-repeat"] : []),
    "shared-warm-memory-empty",
  ])
    for (const variant of shuffled(["control", "candidate"] as const)) {
      try {
        await request(variant, s, condition, session, namespaces[variant]);
      } finally {
        await save();
      }
    }
}
if (process.env.CWS_LOAD === "1") {
  const ids = new Set(
      (process.env.CWS_LOAD_SCENARIOS ?? "")
        .split(",")
        .filter(Boolean)
        .map(Number),
    ),
    workload = contract.scenarios.filter(
      (s: any, i: number) => s.kind === "load" || ids.has(i),
    ),
    count = Number(process.env.CWS_LOAD_COUNT ?? 20);
  assert(workload.length);
  for (const rate of [0.5, 2])
    for (const variant of shuffled(["control", "candidate"] as const)) {
      const namespace = "load-" + randomUUID();
      for (const s of workload)
        await request(variant, s, "load-prime", 0, namespace);
      const start = performance.now(),
        pending: Promise<unknown>[] = [];
      let active = 0;
      for (let i = 0; i < count; i++) {
        const due = start + (i * 1000) / rate;
        await new Promise((r) =>
          setTimeout(r, Math.max(0, due - performance.now())),
        );
        active++;
        const job = request(
          variant,
          workload[i % workload.length],
          "load",
          i,
          namespace,
          {
            arrivalRate: rate,
            launchLagMs: performance.now() - due,
            inFlightAtStart: active,
            loadStartMs: performance.now() - start,
          },
        ).finally(() => active--);
        job.catch(() => {});
        pending.push(job);
      }
      const results = await Promise.allSettled(pending);
      await save();
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length)
        console.error(
          "Load failures",
          variant,
          rate,
          failed.map((r) => String((r as PromiseRejectedResult).reason)),
        );
    }
}
manifest.completedAt = new Date().toISOString();
manifest.notes.push(
  `${rows.filter((r) => r.correct).length}/${rows.length} attempts passed ranked IDs, score tolerance, exact rendering and requested exact totals. Failures are retained separately.`,
);
await save();
