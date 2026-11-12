import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parallel } from "../src/storage/types.js";
import { decodeRoot } from "../src/global/format.js";
const out = process.argv[2] ?? "work/global-100k",
  budget = process.env.GLOBAL_BUDGET ?? "8",
  name = process.env.GLOBAL_WORKER ?? "work-search-global",
  bundle = await readFile(
    out +
      `/${process.env.GLOBAL_HEADS === "1" ? "bundle-heads" : "bundle"}-${budget}.bin`,
  ),
  { root } = decodeRoot(bundle);
const { url } = JSON.parse(
    await readFile("work/full-flp/deployment.json", "utf8"),
  ),
  { INTERNAL_TOKEN: token } = JSON.parse(
    await readFile("work/full-flp/secrets.json", "utf8"),
  );
if (!process.argv.includes("--deploy-only"))
  await parallel(
    root.objects.slice(Number(process.env.GLOBAL_FROM_OBJECT ?? 0)),
    6,
    async (o) => {
      const bytes = await readFile(out + "/packs/" + o.name);
      if (createHash("sha256").update(bytes).digest("hex") !== o.sha256)
        throw Error("Global object checksum mismatch");
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await fetch(
            url +
              "/__upload/" +
              encodeURIComponent(root.generation + "/" + o.name),
            {
              method: "PUT",
              headers: {
                authorization: `Bearer ${token}`,
                "content-length": String(o.size),
                "x-sha256": o.sha256,
              },
              body: createReadStream(out + "/packs/" + o.name),
              duplex: "half",
            } as any,
          );
          if (!r.ok) throw Error("Upload " + r.status);
          break;
        } catch (e) {
          if (attempt >= 4) throw e;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
      console.log("Uploaded global", o.name, o.size);
    },
  );
if (process.argv.includes("--upload-only")) process.exit(0);
await copyFile(
  out +
    `/${process.env.GLOBAL_HEADS === "1" ? "bundle-heads" : "bundle"}-${budget}.bin`,
  "data/global-plan.bin",
);
await mkdir("work/global-deploy", { recursive: true });
const entry = resolve(`work/global-deploy/${name}.ts`);
await writeFile(
  entry,
  `import bytes from ${JSON.stringify(resolve(out + `/${process.env.GLOBAL_HEADS === "1" ? "bundle-heads" : "bundle"}-${budget}.bin`))};import {createGlobalWorker} from ${JSON.stringify(resolve("src/global/worker-runtime.ts"))};export default createGlobalWorker(new Uint8Array(bytes));`,
);
const config = resolve(`work/global-deploy/${name}.json`),
  vars: Record<string, string> = {
    PAGE_CACHE: process.env.GLOBAL_SHARED_CACHE ?? "1",
    DIAGNOSTICS: "0",
    PAGE_CACHE_POLICY: process.env.GLOBAL_CACHE_POLICY ?? "adaptive960",
    COMPETITIVE_POSITIONS: process.env.GLOBAL_COMPETITIVE ?? "0",
    PAGE_READ_KIB: process.env.GLOBAL_PAGE_KIB ?? String(root.pageBytes / 1024),
  };
if (process.env.GLOBAL_PAGE_BASE_URL)
  vars.PAGE_BASE_URL = process.env.GLOBAL_PAGE_BASE_URL;
await writeFile(
  config,
  JSON.stringify(
    {
      name,
      main: entry,
      compatibility_date: "2026-11-01",
      account_id: "8f088d4bd190caf693cc42bb8311fd7d",
      workers_dev: true,
      rules: [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }],
      r2_buckets: [{ binding: "INDEX", bucket_name: "work-search-demo" }],
      vars,
      placement: process.env.GLOBAL_PLACEMENT
        ? process.env.GLOBAL_PLACEMENT === "smart"
          ? { mode: "smart" }
          : { region: process.env.GLOBAL_PLACEMENT }
        : undefined,
      limits: { cpu_ms: 300000 },
    },
    null,
    2,
  ),
);
function wrangler(args: string[], stdin?: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["node_modules/wrangler/bin/wrangler.js", ...args],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error("Wrangler failed " + code)),
    );
  });
}
await wrangler(["deploy", "--config", config]);
await wrangler(["secret", "put", "INTERNAL_TOKEN", "--config", config], token);
console.log("Global deployed", name, root.generation, root.count);
