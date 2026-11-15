import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { benchmarkToken } from "./token.js";

const [name, sourcePath] = process.argv.slice(2);
if (!/^work-search-cws-oracle-[a-z0-9-]+$/.test(name ?? "") || !sourcePath)
  throw Error("Use ISOLATED_ORACLE_NAME SOURCE_ROOT");
const dir = resolve("work/construction-v3/deploy/" + name);
await mkdir(dir, { recursive: true });
const source = JSON.parse(await readFile(sourcePath, "utf8"));
const hash = createHash("sha256");
for (const path of [
  "bench/columnar/deploy-isolated-oracle.ts",
  "bench/columnar/oracle-worker.ts",
  "bench/columnar/oracle-scan.ts",
  "bench/columnar/exhaustive.ts",
  "src/query/analysis.ts",
  "src/query/parser.ts",
  "src/query/tokenize.ts",
  "src/columnar/construction/source.ts",
  "src/columnar/construction/runs.ts",
])
  hash.update(path).update(await readFile(path));
hash.update(JSON.stringify(source));
const code = hash.digest("hex");
await writeFile(
  dir + "/entry.ts",
  `
import {createOracleWorker} from ${JSON.stringify(resolve("bench/columnar/oracle-worker.ts"))};
import {BuildStore,jsonBytes} from ${JSON.stringify(resolve("src/columnar/construction/runs.ts"))};
const oracle=createOracleWorker(${JSON.stringify(source)},${JSON.stringify(code)});
export default {async fetch(request,env){
 if(request.headers.get('authorization')!=='Bearer '+env.INTERNAL_TOKEN)return new Response('Not found',{status:404});
 if(new URL(request.url).pathname==='/source-object'){
  const input=await request.json();const m=/^([a-f0-9]{64})\\/(?:content|info)-\\d+\\.bin$/.exec(input.key);
  if(!m||!${JSON.stringify(source.parts.map((p: any) => p.generation))}.includes(m[1])||!Number.isSafeInteger(input.length)||input.length<1||input.length>32*1048576)return new Response('Invalid source range',{status:400});
  const object=await env.INDEX.get(input.key,{range:{offset:0,length:input.length}});
  if(!object||object.customMetadata?.generation!==m[1])return new Response('Source identity mismatch',{status:404});
  return new Response(object.body,{headers:{'x-generation':m[1],'x-sha256':object.customMetadata?.sha256??''}});
 }
 if(new URL(request.url).pathname==='/stage'){
  const input=await request.json();const output=await new BuildStore(env.INDEX).put(jsonBytes(input.value));return Response.json({output});
 }
 return oracle.fetch(request,env);
}};`,
);
await writeFile(
  dir + "/wrangler.json",
  JSON.stringify(
    {
      name,
      main: dir + "/entry.ts",
      account_id: "8f088d4bd190caf693cc42bb8311fd7d",
      compatibility_date: "2026-11-01",
      workers_dev: true,
      placement: { region: "aws:us-east-1" },
      r2_buckets: [{ binding: "INDEX", bucket_name: "work-search-demo" }],
      limits: { cpu_ms: 300000 },
      observability: { enabled: true },
    },
    null,
    2,
  ),
);
async function run(args: string[], input?: string) {
  await new Promise<void>((ok, no) => {
    const child = spawn("yarn", ["wrangler", ...args], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.stdin.end(input);
    child.once("error", no);
    child.once("exit", (c) =>
      c === 0 ? ok() : no(Error("Wrangler exit " + c)),
    );
  });
}
await run([
  "deploy",
  "--config",
  dir + "/wrangler.json",
  "--outdir",
  dir + "/dist",
]);
await run(
  ["secret", "put", "INTERNAL_TOKEN", "--config", dir + "/wrangler.json"],
  await benchmarkToken(),
);
await writeFile(
  dir + "/manifest.json",
  JSON.stringify({
    name,
    code,
    sourcePath,
    deployedAt: new Date().toISOString(),
  }),
);
console.log(
  JSON.stringify({ name, code, url: `https://${name}.phulin.workers.dev` }),
);
