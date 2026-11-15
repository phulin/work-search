/** Recover missing raw source archives only. Reuse the preserved snapshot text
 * importer; do not rebuild or redeploy any retired search implementation. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, openSync, closeSync, mkdirSync } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  symlink,
  stat,
  rm,
} from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packOpinions } from "../src/content/pack.js";
import { jsonLines } from "../src/builder/jsonl.js";
import { benchmarkToken } from "../bench/columnar/token.js";
import { constructionLock } from "./construction-lock.js";
const out = resolve("work/court-source-repair"),
  original = resolve("work/full-flp");
if (process.argv.includes("--background")) {
  mkdirSync(out, { recursive: true });
  const log = openSync(out + "/run.log", "a"),
    child = spawn(
      process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url)],
      { detached: true, stdio: ["ignore", log, log], env: process.env },
    );
  child.unref();
  closeSync(log);
  console.log("Source recovery coordinator", child.pid);
  process.exit(0);
}
await mkdir(out, { recursive: true });
await constructionLock(out + "/coordinator.lock");
const run = (command: string, args: string[], input?: string) =>
  new Promise<void>((ok, no) => {
    const p = spawn(command, args, { stdio: ["pipe", "inherit", "inherit"] });
    p.stdin.end(input);
    p.once("error", no);
    p.once("exit", (c) =>
      c === 0 ? ok() : no(Error(command + " exited " + c)),
    );
  });
async function progress(stage: string, extra = {}) {
  await writeFile(
    out + "/status.json",
    JSON.stringify(
      { stage, pid: process.pid, at: new Date().toISOString(), ...extra },
      null,
      2,
    ),
  );
}
const published = JSON.parse(
    await readFile(original + "/published.json", "utf8"),
  ),
  parts = Object.values(published.shards)
    .filter((p: any) => p.id >= 254)
    .sort((a: any, b: any) => a.id - b.id) as any[];
if (parts.length !== 12 || parts[0].id !== 254 || parts.at(-1).id !== 265)
  throw Error("Unexpected recovery inventory");
const importerRoot = out + "/import";
await mkdir(importerRoot + "/batches", { recursive: true });
for (const name of [
  "opinions-2026-09-30.csv.bz2",
  "opinions-2026-09-30.csv.bz2.download.json",
  "metadata.sqlite",
  "metadata-progress.json",
])
  await symlink(original + "/" + name, importerRoot + "/" + name).catch((e) => {
    if (e.code !== "EEXIST") throw e;
  });
await writeFile(
  importerRoot + "/batches/00253.json",
  await readFile(original + "/batches/00253.json"),
);
// The original importer changed its batch size after partition 258. Generate
// 50k batches, then join whole batches to reproduce the recorded boundaries.
const importer = spawn(
  resolve("work/flp-venv/bin/python"),
  [
    "scripts/import-flp.py",
    "--root",
    importerRoot,
    "--batch-docs",
    "50000",
    "--decoder-threads",
    "2",
  ],
  { stdio: ["ignore", "inherit", "inherit"] },
);
let importerDone = false,
  importerError: unknown;
const imported = new Promise<void>((ok, no) => {
  importer.once("error", (e) => {
    importerError = e;
    no(e);
  });
  importer.once("exit", (c) => {
    importerDone = true;
    if (c === 0) ok();
    else {
      importerError = Error("Snapshot recovery importer exited " + c);
      no(importerError);
    }
  });
});
imported.catch(() => {});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    importer.kill(signal);
    process.exit(1);
  });
// Construction analytics are sampled periodically even while the local source
// replay is busy. A transient analytics failure must not discard recovered data.
let usagePending = false;
async function usage() {
  if (usagePending) return;
  usagePending = true;
  try {
    await run("yarn", [
      "node",
      "--import",
      "tsx",
      "scripts/cloudflare-usage.ts",
      "1",
      out + "/usage",
    ]);
  } catch (e) {
    console.error("Usage snapshot failed:", String(e));
  } finally {
    usagePending = false;
  }
}
await usage();
const usageTimer = setInterval(() => void usage(), 15 * 60 * 1000);
usageTimer.unref();
let deployed = false;
const worker = "work-search-source-restore",
  url = `https://${worker}.phulin.workers.dev`,
  config = out + "/wrangler.json",
  token = await benchmarkToken();
async function deploy() {
  if (deployed) return;
  const generations = parts.map((p) => p.generation);
  await writeFile(
    out + "/worker.ts",
    `const allowed=new Set(${JSON.stringify(generations)});
export default{async fetch(request,env){
if(request.headers.get('authorization')!=='Bearer '+env.TOKEN)return new Response('Not found',{status:404});
if(new URL(request.url).pathname==='/health')return new Response('Ready');
const key=new URL(request.url).pathname.slice(1),[generation,name]=key.split('/');
if(!allowed.has(generation)||!/^(contentmap|content|info)-[0-9]+[.]bin$/.test(name)||key.split('/').length!==2)return new Response('Invalid key',{status:400});
const old=await env.INDEX.head(key);
if(request.method==='HEAD')return new Response(null,{status:old?200:404,headers:old?{'x-sha256':old.customMetadata?.sha256??'','x-generation':old.customMetadata?.generation??'','content-length':String(old.size)}:{}});
const sha=request.headers.get('x-sha256'),size=Number(request.headers.get('content-length'));
if(request.method!=='PUT'||!request.body||!/^([a-f0-9]{64})$/.test(sha??'')||!Number.isSafeInteger(size)||size<1||size>67108864)return new Response('Invalid upload',{status:400});
if(old)return new Response('Immutable conflict',{status:409});
const fixed=new FixedLengthStream(size),transfer=request.body.pipeTo(fixed.writable);
await Promise.all([env.INDEX.put(key,fixed.readable,{sha256:sha,customMetadata:{generation,sha256:sha}}),transfer]);
return new Response('Stored');}};`,
  );
  await writeFile(
    config,
    JSON.stringify({
      name: worker,
      main: out + "/worker.ts",
      account_id: "8f088d4bd190caf693cc42bb8311fd7d",
      compatibility_date: "2026-11-01",
      workers_dev: true,
      r2_buckets: [{ binding: "INDEX", bucket_name: "work-search-demo" }],
    }),
  );
  await run("yarn", ["wrangler", "deploy", "--config", config]);
  await run(
    "yarn",
    ["wrangler", "secret", "put", "TOKEN", "--config", config],
    token,
  );
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url + "/health", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (r.ok) break;
    if (attempt === 7)
      throw Error("Source recovery Worker activation " + r.status);
    await new Promise((r) => setTimeout(r, 2000));
  }
  deployed = true;
}
async function digestFile(file: string) {
  const h = createHash("sha256");
  for await (const b of createReadStream(file)) h.update(b);
  return h.digest("hex");
}
let nextInput = 254;
try {
  await progress("replaying-snapshot-prefix", { firstMissingPartition: 254 });
  for (const part of parts) {
    const dir = out + `/part-${part.id}`,
      input = dir + "/input.jsonl",
      expected = JSON.parse(
        await readFile(
          original + `/batches/${String(part.id).padStart(5, "0")}.json`,
          "utf8",
        ),
      ),
      inputs = Math.ceil(part.documents / 50000);
    await mkdir(dir, { recursive: true });
    const receipt = await readFile(dir + "/complete.json", "utf8").then(
      JSON.parse,
      () => undefined,
    );
    if (receipt) {
      if (receipt.inputSha256 !== part.inputSha256)
        throw Error("Recovery source changed");
      for (let i = 0; i < inputs; i++)
        await rm(
          importerRoot +
            `/queue/${String(nextInput + i).padStart(5, "0")}.jsonl`,
          { force: true },
        );
      nextInput += inputs;
      continue;
    }
    if (
      await stat(input).then(
        () => false,
        () => true,
      )
    ) {
      const { open } = await import("node:fs/promises"),
        file = await open(input + ".tmp", "w");
      let documents = 0;
      try {
        for (let i = 0; i < inputs; i++) {
          const path =
            importerRoot +
            `/queue/${String(nextInput + i).padStart(5, "0")}.jsonl`;
          while (
            !(await stat(path).then(
              () => true,
              () => false,
            ))
          ) {
            if (importerError) throw importerError;
            if (importerDone)
              throw Error("Snapshot recovery ended before tail coverage");
            await new Promise((r) => setTimeout(r, 1000));
          }
          for await (const line of jsonLines(path)) {
            if (!line.trim()) continue;
            await file.writeFile(line + "\n");
            documents++;
          }
        }
      } finally {
        await file.close();
      }
      if (documents !== part.documents)
        throw Error("Recovered partition count differs");
      const { rename } = await import("node:fs/promises");
      await rename(input + ".tmp", input);
    }
    if (
      (await digestFile(input)) !== expected.sha256 ||
      expected.sha256 !== part.inputSha256
    )
      throw Error("Recovered corpus bytes differ from archived input");
    await progress("restoring-source-partition", {
      partition: part.id,
      documents: part.documents,
    });
    const ids: string[] = [];
    for await (const line of jsonLines(input))
      if (line.trim()) ids.push(JSON.parse(line).id);
    const manifest = await packOpinions(
      input,
      dir + "/archive",
      part.documents,
      (i) => ids[i],
    );
    await deploy();
    for (const object of manifest.objects) {
      const key = part.generation + "/" + object.name,
        headers = { authorization: `Bearer ${token}` };
      for (let attempt = 0; ; attempt++) {
        try {
          const head = await fetch(url + "/" + key, {
            method: "HEAD",
            headers,
          });
          if (head.ok) {
            if (
              head.headers.get("x-sha256") !== object.sha256 ||
              Number(head.headers.get("content-length")) !== object.size ||
              head.headers.get("x-generation") !== part.generation
            )
              throw Error("Existing archive conflicts with recovered source");
            break;
          }
          if (head.status !== 404) throw Error("Archive HEAD " + head.status);
          const response = await fetch(url + "/" + key, {
            method: "PUT",
            headers: {
              ...headers,
              "content-length": String(object.size),
              "x-sha256": object.sha256,
            },
            body: createReadStream(dir + "/archive/" + object.name),
            duplex: "half",
          } as any);
          if (!response.ok)
            throw Error(
              "Archive restore " +
                response.status +
                " " +
                (await response.text()),
            );
          break;
        } catch (e) {
          if (attempt >= 5 || String(e).includes("conflicts")) throw e;
          await new Promise((r) =>
            setTimeout(r, Math.min(10000, 1000 * 2 ** attempt)),
          );
        }
      }
    }
    await writeFile(
      dir + "/complete.json",
      JSON.stringify({
        inputSha256: part.inputSha256,
        generation: part.generation,
        documents: part.documents,
        objects: manifest.objects,
        at: new Date().toISOString(),
      }),
    );
    for (let i = 0; i < inputs; i++)
      await rm(
        importerRoot + `/queue/${String(nextInput + i).padStart(5, "0")}.jsonl`,
        { force: true },
      );
    nextInput += inputs;
    await rm(input, { force: true });
    await rm(dir + "/archive", { recursive: true, force: true });
  }
  await imported;
  await progress("source-restored");
  if (deployed)
    await run("yarn", ["wrangler", "delete", "--config", config, "--force"]);
  await run("yarn", [
    "node",
    "--import",
    "tsx",
    "scripts/build-court-corpus.ts",
    "work/court-cases-full",
    "court-cases-full-20261115",
    "--background",
  ]);
  await progress("full-corpus-run-resumed");
} catch (e) {
  importer.kill("SIGTERM");
  await progress("failed", { error: String(e) });
  throw e;
} finally {
  clearInterval(usageTimer);
}
