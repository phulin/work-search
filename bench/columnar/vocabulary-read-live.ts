import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { deepStrictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { benchmarkToken } from "./token.js";
import { constructionHTTP } from "../../scripts/construction-http.js";
const out = "work/vocabulary-read-fix/live",
  dir = "work/court-cases-full/index",
  words = dir + "/vocabulary-words",
  name = "work-search-vocabulary-pilot",
  url = `https://${name}.phulin.workers.dev`,
  config = out + "/wrangler.json";
await mkdir(out, { recursive: true });
const meta = JSON.parse(await readFile(words + "/manifest.json", "utf8")),
  state = JSON.parse(await readFile(dir + "/build.json", "utf8")),
  source = JSON.parse(
    await readFile("work/court-cases-full/source/source-root.json", "utf8"),
  ),
  token = await benchmarkToken();
for (const file of ["hot.bin", "ids.bin"])
  await writeFile(out + "/" + file, await readFile(words + "/" + file));
await writeFile(
  out + "/entry.ts",
  `import hot from './hot.bin';import ids from './ids.bin';import{vocabularyReadPilot}from${JSON.stringify(resolve("bench/columnar/vocabulary-read-worker.ts"))};export default vocabularyReadPilot(${JSON.stringify(source)} as any,{generation:${JSON.stringify(meta.generation)},count:${meta.count},rootSha256:${JSON.stringify(meta.rootSha256)},packets:${JSON.stringify(meta.packets)},hot:new Uint8Array(hot),ids:new Uint32Array(ids)});`,
);
await writeFile(
  config,
  JSON.stringify({
    name,
    main: resolve(out + "/entry.ts"),
    account_id: "8f088d4bd190caf693cc42bb8311fd7d",
    compatibility_date: "2026-11-01",
    workers_dev: true,
    placement: { region: "aws:us-east-1" },
    r2_buckets: [{ binding: "INDEX", bucket_name: "work-search-demo" }],
    limits: { cpu_ms: 300000 },
    observability: { enabled: true },
    rules: [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }],
  }),
);
async function run(args: string[], input?: string) {
  await new Promise<void>((ok, no) => {
    const p = spawn("yarn", ["wrangler", ...args], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    p.stdin.end(input);
    p.once("error", no);
    p.once("exit", (c) => (c === 0 ? ok() : no(Error("Wrangler " + c))));
  });
}
await run(["deploy", "--config", config]);
await run(["secret", "put", "INTERNAL_TOKEN", "--config", config], token);
for (let retry = 0; ; retry++) {
  const r = await fetch(url + "/health", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (r.ok) break;
  if (retry >= 10) throw Error("Pilot activation " + r.status);
  await new Promise((r) => setTimeout(r, 2000));
}
const post = constructionHTTP(1),
  rows: any[] = [],
  cases = [0, 1000000, 5776227, 8000000],
  repeats = Number(process.env.CWS_PILOT_REPEATS ?? 2);
async function call(route: string, input: any) {
  const started = performance.now(),
    response = await post(
      url + route,
      token,
      JSON.stringify({ ...input, rootRef: state.rootRef }),
    ),
    body = await response.text();
  if (!response.ok) throw Error(route + " " + response.status + " " + body);
  return { ...JSON.parse(body), clientMs: performance.now() - started };
}
for (let repeat = 0; repeat < repeats; repeat++)
  for (const [index, first] of cases.entries()) {
    const count = 128,
      results: any = {};
    for (const route of (repeat + index) % 2
      ? ["/compact", "/control"]
      : ["/control", "/compact"]) {
      results[route] = await call(route, { first, count });
      rows.push({ repeat, first, count, route, ...results[route] });
      await writeFile(out + "/results.json", JSON.stringify({ rows }, null, 2));
      console.log(
        route,
        first,
        Math.round(results[route].wallMs),
        results[route].r2,
      );
    }
    const old = results["/control"].output,
      compact = results["/compact"].output;
    deepStrictEqual(
      { first: old.first, end: old.end, vocabulary: old.vocabulary },
      {
        first: compact.first,
        end: compact.end,
        vocabulary: compact.vocabulary,
      },
    );
    for (const route of (repeat + index) % 2
      ? ["/fused", "/seeded"]
      : ["/seeded", "/fused"]) {
      results[route] = await call(route, {
        first,
        count,
        vocabularyRef: old.vocabulary,
      });
      rows.push({ repeat, first, count, route, ...results[route] });
      await writeFile(out + "/results.json", JSON.stringify({ rows }, null, 2));
      console.log(
        route,
        first,
        Math.round(results[route].wallMs),
        results[route].r2,
      );
    }
    deepStrictEqual(
      results["/fused"].output.group,
      results["/seeded"].output.group,
    );
  }
const summary = {
  rows,
  completedAt: new Date().toISOString(),
  sourceGeneration: meta.generation,
  rootSha256: state.rootRef.sha256,
  commonTerms: meta.hotTerms,
  bundleBytes: meta.hotBytes + meta.idsBytes,
  packets: meta.packets.length,
  wordManifestSha256: createHash("sha256")
    .update(await readFile(words + "/manifest.json"))
    .digest("hex"),
  notes:
    "Live Workers/R2. Sequential alternating controls with cold application lookup caches for every call. Opaque R2 backend cache state uncontrolled. Per-case vocabulary and document-group SHA identities match. No public serving deployment.",
};
await writeFile(out + "/results.json", JSON.stringify(summary, null, 2));
await run(["delete", "--config", config, "--force"]);
console.log("Pilot complete", rows.length);
