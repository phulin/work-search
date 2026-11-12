import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
const names = (process.env.GLOBAL_NATIVE_VARIANTS ?? "")
    .split(",")
    .filter(Boolean),
  label = process.env.GLOBAL_NATIVE_LABEL ?? "retrieval-round2-native";
if (!names.length) throw Error("GLOBAL_NATIVE_VARIANTS required");
await mkdir("work/global-bench", { recursive: true });
const tails = names.map((name) => {
  const child = spawn(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "tail",
      "--config",
      `work/global-deploy/${name}.json`,
      "--format",
      "json",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "",
    errors = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (errors += b));
  return { name, child, output: () => output, errors: () => errors };
});
try {
  await new Promise((r) => setTimeout(r, 15000));
  await new Promise<void>((ok, no) => {
    const c = spawn(
      process.execPath,
      ["--import", "tsx", "bench/global-native-competitive.ts"],
      { env: { ...process.env, GLOBAL_NATIVE_LABEL: label }, stdio: "inherit" },
    );
    c.once("error", no);
    c.once("exit", (code) =>
      code === 0 ? ok() : no(Error("Native benchmark exited " + code)),
    );
  });
  await new Promise((r) => setTimeout(r, 5000));
} finally {
  await Promise.all(
    tails.map(
      (t) =>
        new Promise<void>((ok) => {
          if (t.child.exitCode !== null) {
            ok();
            return;
          }
          t.child.once("exit", () => ok());
          t.child.kill("SIGTERM");
        }),
    ),
  );
  const rows: any[] = [];
  for (const t of tails) {
    let depth = 0,
      start = 0,
      quoted = false,
      escaped = false;
    const s = t.output();
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
        continue;
      }
      if (c === '"') quoted = true;
      else if (c === "{") {
        if (!depth) start = i;
        depth++;
      } else if (c === "}" && --depth === 0) {
        const v = JSON.parse(s.slice(start, i + 1)),
          url = v.event?.request?.url;
        if (url)
          rows.push({
            name: t.name,
            q: new URL(url).searchParams.get("q"),
            outcome: v.outcome,
            cpuMs: v.cpuTime,
            wallMs: v.wallTime,
          });
      }
    }
  }
  // Never save raw tail events: they contain request Authorization headers.
  await writeFile(
    `work/global-bench/${label}-cpu.json`,
    JSON.stringify({
      kind: "Cloudflare live tail CPU/wall metrics, sanitized; request coverage may be sampled",
      rows,
      stderrBytes: tails.map((t) => ({
        name: t.name,
        bytes: t.errors().length,
      })),
    }),
  );
}
