import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { benchmarkToken } from "./token.js";
const dir =
  "work/columnar-bench/" + (process.env.CWS_PROFILE_LABEL ?? "native-profiles");
await mkdir(dir, { recursive: true });
const { stdout } = await promisify(execFile)(process.execPath, [
  "node_modules/wrangler/bin/wrangler.js",
  "auth",
  "token",
  "--json",
]);
const { token } = JSON.parse(stdout),
  internal = await benchmarkToken(),
  captures: any[] = [];
for (const name of (
  process.env.CWS_VARIANTS ?? "work-search-cws-control,work-search-cws-v3"
).split(",")) {
  const base = `https://api.cloudflare.com/client/v4/accounts/8f088d4bd190caf693cc42bb8311fd7d`,
    headers = { authorization: `Bearer ${token}` },
    deployed = (await fetch(`${base}/workers/scripts/${name}/deployments`, {
      headers,
    }).then((r) => r.json())) as any;
  if (!deployed.success)
    throw Error("Deployment API " + JSON.stringify(deployed.errors));
  const version = deployed.result.deployments[0].versions[0].version_id;
  for (const type of ["cpu", "heap"]) {
    let active = true,
      cursor = 0;
    const calls: any[] = [],
      queries = [
        "summary judgment",
        '"clear and convincing evidence"',
        "subject /5 matter jurisdiction",
        "court",
      ];
    const traffic = Array.from({ length: 2 }, async () => {
      while (active) {
        const q = queries[cursor++ % queries.length],
          start = performance.now();
        try {
          const r = await fetch(`https://${name}.phulin.workers.dev/search`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${internal}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ q, resetMemory: true }),
              signal: AbortSignal.timeout(60000),
            }),
            b = (await r.json()) as any;
          calls.push({
            q,
            status: r.status,
            ms: performance.now() - start,
            telemetry: b.telemetry,
            diagnostics: b.diagnostics,
          });
        } catch (e) {
          calls.push({ q, error: String(e) });
        }
      }
    });
    try {
      await new Promise((r) =>
        setTimeout(r, Number(process.env.CWS_PROFILE_PREWARM_MS ?? 30000)),
      );
      const start = performance.now(),
        r = await fetch(
          `${base}/workers/workers/${name}/versions/${process.env.CWS_PROFILE_VERSION ?? version}/profile`,
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ duration_ms: 15000, profile_type: type }),
            signal: AbortSignal.timeout(60000),
          },
        ),
        bytes = Buffer.from(await r.arrayBuffer()),
        file = `${name}-${type}.${r.ok ? "pprof" : "error.json"}`;
      await writeFile(dir + "/" + file, bytes);
      captures.push({
        name,
        version,
        type,
        status: r.status,
        bytes: bytes.length,
        file,
        ms: performance.now() - start,
      });
      console.log(captures.at(-1));
    } finally {
      active = false;
      await Promise.all(traffic);
      await writeFile(
        dir + `/${name}-${type}-requests.json`,
        JSON.stringify(calls),
      );
      await writeFile(
        dir + "/captures.json",
        JSON.stringify(captures, null, 2),
      );
    }
  }
}
