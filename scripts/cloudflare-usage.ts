import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
const account = "8f088d4bd190caf693cc42bb8311fd7d",
  hours = Number(process.argv[2] ?? 6),
  out = process.argv[3] ?? "work/cloudflare-usage";
if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 31)
  throw Error(
    "Usage: cloudflare-usage.ts HOURS OUTPUT_DIRECTORY (maximum 31 days)",
  );
const { stdout } = await promisify(execFile)(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js",
    "auth",
    "token",
    "--json",
  ]),
  token = JSON.parse(stdout).token,
  headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  end = new Date().toISOString(),
  start = new Date(Date.now() - hours * 3600000).toISOString();
const query = `{viewer{accounts(filter:{accountTag:"${account}"}){
workersInvocationsAdaptive(limit:1000,filter:{datetime_geq:"${start}",datetime_leq:"${end}"}){dimensions{scriptName status} sum{requests errors cpuTimeUs subrequests} quantiles{memoryUsageBytesP50 memoryUsageBytesP99 cpuTimeP99}}
r2OperationsAdaptiveGroups(limit:1000,filter:{datetime_geq:"${start}",datetime_leq:"${end}"}){dimensions{bucketName actionType actionStatus} sum{requests responseBytes responseObjectSize}}
r2StorageAdaptiveGroups(limit:100,filter:{datetime_geq:"${new Date(Date.now() - 3600000).toISOString()}",datetime_leq:"${end}"}){dimensions{bucketName} max{payloadSize metadataSize objectCount}}
}}}`;
const [response, scriptsResponse] = await Promise.all([
  fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  }),
  fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`,
    { headers },
  ),
]);
const raw = (await response.json()) as any,
  scripts = (await scriptsResponse.json()) as any;
if (!response.ok || raw.errors || !scripts.success)
  throw Error(
    JSON.stringify({
      status: response.status,
      errors: raw.errors,
      scriptsErrors: scripts.errors,
    }),
  );
const data = raw.data.viewer.accounts[0],
  workers = data.workersInvocationsAdaptive as any[],
  operations = data.r2OperationsAdaptiveGroups as any[],
  storage = data.r2StorageAdaptiveGroups as any[],
  total = (rows: any[], key: string) =>
    rows.reduce((n, row) => n + (row.sum[key] ?? 0), 0),
  build = workers.filter((r) =>
    r.dimensions.scriptName.startsWith("work-search-cws-build-"),
  ),
  bucket = operations.filter(
    (r) => r.dimensions.bucketName === "work-search-demo",
  ),
  summary = {
    start,
    end,
    scriptCount: scripts.result.length,
    scriptLimit: 500,
    workers: {
      requests: total(workers, "requests"),
      errors: total(workers, "errors"),
      cpuMs: total(workers, "cpuTimeUs") / 1000,
    },
    construction: {
      requests: total(build, "requests"),
      errors: total(build, "errors"),
      maxReportedMemoryP99Bytes: Math.max(
        0,
        ...build.map((r) => r.quantiles.memoryUsageBytesP99),
      ),
    },
    unattributedWorkerRequests: total(
      workers.filter((r) => r.dimensions.scriptName === "__unknown__"),
      "requests",
    ),
    resourceErrors: workers.filter((r) =>
      /exceeded|limit|memory|cpu/i.test(r.dimensions.status),
    ),
    bucket: {
      reads: total(
        bucket.filter((r) =>
          /GetObject|HeadObject|HeadBucket/.test(r.dimensions.actionType),
        ),
        "requests",
      ),
      writes: total(
        bucket.filter((r) => /PutObject/.test(r.dimensions.actionType)),
        "requests",
      ),
      readBytes: total(bucket, "responseBytes"),
      storage: storage.find(
        (r) => r.dimensions.bucketName === "work-search-demo",
      )?.max,
    },
    notes: [
      "Account and bucket totals include other work; adaptive analytics can lag and contain unattributed scripts.",
      "Memory quantiles sample isolate memory at invocation, not peak memory or cumulative allocation.",
      "Paid usage allowances are billing thresholds, not hard request limits. This is not an invoice.",
    ],
  };
await mkdir(out, { recursive: true });
const path = out + "/" + end.replaceAll(":", "-") + ".json";
await writeFile(path, JSON.stringify({ summary, raw }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log("Saved", path);
