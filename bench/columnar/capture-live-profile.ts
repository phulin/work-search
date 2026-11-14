import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { benchmarkToken } from "./token.js";
const [name, out, mode = "search"] = process.argv.slice(2);
if (!out) throw Error("Use WORKER OUTPUT_DIRECTORY [search|repeat]");
await mkdir(out, { recursive: true });
const { stdout } = await promisify(execFile)(process.execPath, [
  "node_modules/wrangler/bin/wrangler.js",
  "auth",
  "token",
  "--json",
]);
const cfToken = JSON.parse(stdout).token,
  token = await benchmarkToken();
const contract = JSON.parse(
  await readFile("bench/results/columnar/deployment-1m/contract.json", "utf8"),
).scenarios[8];
const captures: any[] = [];
for (const type of ["cpu", "heap"]) {
  let active = true;
  const calls: any[] = [];
  const traffic = (async () => {
    do {
      const start = performance.now();
      try {
        const response = await fetch(
          `https://${name}.phulin.workers.dev/${mode === "repeat" ? "__capture" : "search"}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              q: contract.q,
              ...contract.options,
              durationMs: 40000,
              metadata: true,
              snippets: true,
              cacheNamespace: "native-capture",
              resetMemory: false,
            }),
            signal: AbortSignal.timeout(90000),
          },
        );
        const body: any = await response.json();
        calls.push({
          status: response.status,
          ms: performance.now() - start,
          body,
        });
      } catch (error) {
        calls.push({ error: String(error) });
      }
    } while (active && mode !== "repeat");
  })();
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const started = performance.now(),
      r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/8f088d4bd190caf693cc42bb8311fd7d/workers/workers/${name}/versions/latest-deployed/profile`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${cfToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ duration_ms: 20000, profile_type: type }),
          signal: AbortSignal.timeout(60000),
        },
      );
    const data = Buffer.from(await r.arrayBuffer());
    const file = type + (r.ok ? ".pprof" : ".error.json");
    await writeFile(out + "/" + file, data);
    captures.push({
      name,
      mode,
      type,
      status: r.status,
      bytes: data.length,
      file,
      ms: performance.now() - started,
    });
    console.log(captures.at(-1));
  } finally {
    active = false;
    await traffic;
    await writeFile(
      out + "/" + type + "-traffic.json",
      JSON.stringify(calls, null, 2),
    );
    await writeFile(out + "/captures.json", JSON.stringify(captures, null, 2));
  }
}
