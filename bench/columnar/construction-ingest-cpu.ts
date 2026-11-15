import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { benchmarkToken } from "./token.js";
import { decodeRunBlock } from "../../src/columnar/construction/block-codec.js";
const [control, candidate, out] = process.argv.slice(2);
if (
  !out ||
  [control, candidate].some(
    (url) =>
      !/^https:\/\/work-search-cws-fresh-[a-z0-9-]+\.phulin\.workers\.dev$/.test(
        url,
      ),
  )
)
  throw Error(
    "Use ISOLATED_CONTROL_URL ISOLATED_CANDIDATE_URL OUTPUT_DIRECTORY",
  );
await mkdir(out, { recursive: true });
const token = await benchmarkToken(),
  headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
const health = (await Promise.all(
  [control, candidate].map((url) =>
    fetch(url + "/health", { headers }).then((r) => r.json()),
  ),
)) as any[];
if (health[0].source !== health[1].source)
  throw Error("Ingest CPU comparison source mismatch");
const seed = 885127,
  count = Number(process.env.CWS_INGEST_COUNT ?? 128),
  repetitions = Number(process.env.CWS_INGEST_REPETITIONS ?? 3),
  jobs = [0, 100000, 500000, 900000]
    .flatMap((first) =>
      Array.from({ length: repetitions }, (_, repetition) =>
        [0, 1].map((variant) => ({ first, repetition, variant })),
      ),
    )
    .flat();
let randomState = seed;
for (let i = jobs.length - 1; i > 0; i--) {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  const j = Math.floor((randomState / 4294967296) * (i + 1));
  [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
}
const rows: any[] = [],
  attempts: any[] = [],
  reference = new Map<number, string>(),
  build = "ingest-cpu-" + Date.now();
for (const [index, job] of jobs.entries()) {
  const url = [control, candidate][job.variant];
  let output: any,
    ray: string | undefined,
    telemetry: any,
    ms = 0;
  for (let attempt = 0; ; attempt++) {
    const started = performance.now(),
      response = await fetch(url + "/ingest", {
        method: "POST",
        headers,
        body: JSON.stringify({
          build,
          task: "ingest-" + index,
          first: job.first,
          count,
        }),
      });
    const body = (await response.json()) as any;
    ms = performance.now() - started;
    attempts.push({
      ...job,
      attempt,
      status: response.status,
      ms,
      telemetry: body.telemetry,
    });
    if (response.ok) {
      output = body.output;
      ray = response.headers.get("cf-ray")?.split("-")[0];
      telemetry = body.telemetry;
      break;
    }
    if (response.status !== 503 || attempt >= 30)
      throw Error(JSON.stringify(body));
    await new Promise((r) => setTimeout(r, 250));
  }
  const hash = createHash("sha256");
  let verificationBytes = 0;
  for (const ref of output.chunks) {
    const response = await fetch(url + "/download", {
      method: "POST",
      headers,
      body: JSON.stringify({ ref }),
    });
    if (!response.ok)
      throw Error("Ingest verification read " + response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
    verificationBytes += bytes.length;
    if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256)
      throw Error("Ingest verification checksum mismatch");
    hash.update(await decodeRunBlock(bytes, ref.codec ?? "raw", ref.rawBytes));
  }
  hash.update(
    JSON.stringify([
      output.first,
      output.next,
      output.bodyTokens,
      output.titleTokens,
    ]),
  );
  const sha256 = hash.digest("hex"),
    expected = reference.get(job.first);
  reference.set(job.first, sha256);
  if (expected && expected !== sha256)
    throw Error("Changed ingestion rows " + job.first);
  rows.push({
    ...job,
    ms,
    ray,
    telemetry,
    documents: output.next - output.first,
    analysisWork: output.analysisWork,
    sha256,
    verificationBytes,
  });
  await writeFile(
    out + "/results.json",
    JSON.stringify(
      {
        control,
        candidate,
        health,
        seed,
        count,
        repetitions,
        build,
        rows,
        attempts,
        notes: [
          "Randomized interleaving, identical archived ranges and request sizes, concurrency one.",
          "All expanded sorted posting bytes and field totals must match exactly.",
          "Verification transfers are excluded from ingest elapsed time and reported separately.",
          "Opaque R2 backend caches are uncontrolled. Native CPU must be joined from Cloudflare logs by CF-Ray.",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    index + 1,
    "/",
    jobs.length,
    job.variant ? "candidate" : "control",
    job.first,
    Math.round(ms),
    "ms",
    output.analysisWork ?? "",
  );
}
