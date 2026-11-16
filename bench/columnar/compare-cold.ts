import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { benchmarkToken } from "./token.js";

const [index, contractPath, output] = process.argv.slice(2);
if (!output) throw Error("Use INDEX QUERY_CONTRACT_GZ OUTPUT_GZ");
const names = (process.env.CWS_VARIANTS ?? "").split(",").filter(Boolean);
if (
  names.length < 2 ||
  names.some((n) => !/^work-search-cws-[a-z0-9-]+$/.test(n))
)
  throw Error("Set CWS_VARIANTS to isolated benchmark Worker names");
const root = JSON.parse(await readFile(index + "/root.json", "utf8")),
  rawContract = await readFile(contractPath),
  contract = JSON.parse(gunzipSync(rawContract).toString()),
  ids = process.env.CWS_QUERY_IDS?.split(",").map(Number),
  scenarios = contract.scenarios
    .map((s: any, sid: number) => ({
      sid,
      q: s.q,
      kind: s.kind,
      options: {
        ...s.options,
        exactTotal: false,
        metadata: true,
        snippets: true,
      },
    }))
    .filter((s: any) => !ids || ids.includes(s.sid)),
  repeats = Number(process.env.CWS_REPEATS ?? 3),
  token = await benchmarkToken(),
  health: Record<string, any> = {},
  code = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
if (
  !scenarios.length ||
  scenarios.some((s: any) => s.options.after) ||
  !Number.isInteger(repeats) ||
  repeats < 1
)
  throw Error("Invalid scenario selection or repeats");
for (const name of names) {
  const response = await fetch(`https://${name}.phulin.workers.dev/health`);
  if (!response.ok) throw Error("Health " + response.status);
  health[name] = await response.json();
  assert.deepEqual(
    [health[name].generation, health[name].documents, health[name].corpusHash],
    [root.generation, root.count, root.corpusHash],
  );
}
let seed = Number(process.env.CWS_SEED ?? 916271);
const initialSeed = seed,
  random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
const jobs = Array.from({ length: repeats }, (_, repeat) =>
    scenarios.flatMap((s: any) =>
      names.map((name) => ({ s, name, repeat, order: random() })),
    ),
  )
    .flat()
    .sort((a, b) => a.order - b.order),
  rows: any[] = [],
  references = new Map<number, any[]>(),
  provenance = {
    startedAt: new Date().toISOString(),
    names,
    health,
    code,
    scenarios,
    repeats,
    seed: initialSeed,
    contractSha256: createHash("sha256").update(rawContract).digest("hex"),
    exactTotal: false,
    condition:
      "Unique shared-cache namespace and in-request application reset for every request; response caching disabled",
    client: {
      region: process.env.CWS_CLIENT_REGION ?? "local-New-England",
      node: process.version,
    },
    notes: [
      "Randomized interleaving; complete responses include metadata and snippets.",
      "Equality between variants supplements independent oracle validation; it does not replace it.",
      "Opaque R2 backend caches are not controlled; scenario percentiles are not production traffic percentiles.",
    ],
  };
await mkdir(dirname(output), { recursive: true });
await writeFile(output + ".jsonl", "");
await writeFile(output, gzipSync(JSON.stringify({ ...provenance, rows: [] })));
for (const { s, name, repeat } of jobs) {
  const requestId = randomUUID(),
    namespace = "compare-" + randomUUID(),
    startedAt = new Date().toISOString(),
    start = performance.now();
  let row: any;
  try {
    const response = await fetch(
        `https://${name}.phulin.workers.dev/search?requestId=${requestId}`,
        {
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
        },
      ),
      text = await response.text(),
      clientMs = performance.now() - start;
    let result: any;
    try {
      result = JSON.parse(text);
    } catch {
      result = { error: text.slice(0, 1000) };
    }
    row = {
      sid: s.sid,
      q: s.q,
      name,
      repeat,
      requestId,
      namespace,
      startedAt,
      status: response.status,
      clientMs,
      responseBytes: Buffer.byteLength(text),
      responseHeaders: {
        ray: response.headers.get("cf-ray"),
        contentType: response.headers.get("content-type"),
        requestId: response.headers.get("x-request-id"),
      },
      result,
    };
    if (!response.ok)
      throw Error("HTTP " + response.status + ": " + result.error);
    assert.equal(result.generation, root.generation);
    assert.equal(result.total, undefined);
    assert.equal(result.diagnostics.applicationReset, true);
    assert.equal(result.diagnostics.namespace, namespace);
    assert.equal(
      result.telemetry.version.id,
      health[name].version.id,
      "Deployment changed during comparison",
    );
    const previous = references.get(s.sid);
    if (previous) {
      assert.deepEqual(
        result.results.map(({ score: _score, ...h }: any) => h),
        previous.map(({ score: _score, ...h }: any) => h),
        s.q,
      );
      result.results.forEach((h: any, i: number) =>
        assert(
          Math.abs(h.score - previous[i].score) <=
            1e-10 * Math.max(1, Math.abs(h.score)),
          s.q + " score",
        ),
      );
      row.compared = true;
    } else references.set(s.sid, result.results);
    row.correct = true;
  } catch (error) {
    row = {
      ...row,
      sid: s.sid,
      q: s.q,
      name,
      repeat,
      requestId,
      clientMs: performance.now() - start,
      error: String(error),
    };
  }
  rows.push(row);
  await appendFile(output + ".jsonl", JSON.stringify(row) + "\n");
  console.log(
    rows.length,
    "/",
    jobs.length,
    name,
    s.sid,
    Math.round(row.clientMs) + "ms",
    row.error ?? "OK",
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
if (rows.some((r) => r.error)) process.exitCode = 1;
