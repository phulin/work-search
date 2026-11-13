import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { demoWorkload } from "../demo-workload.js";
import { globalQueries } from "../global-workload.js";
import { benchmarkToken } from "./token.js";
const variants = (
    process.env.CWS_VARIANTS ?? "work-search-cws-control,work-search-cws-near"
  ).split(","),
  label = process.env.CWS_LABEL ?? "pilot",
  sessions = Number(process.env.CWS_SESSIONS ?? 2),
  repeats = Number(process.env.CWS_REPEATS ?? 1),
  condition = process.env.CWS_CONDITION ?? "shared-warm-memory-empty",
  token = await benchmarkToken();
const heldout =
  process.env.CWS_HELDOUT === "1"
    ? JSON.parse(await readFile("work/columnar-bench/heldout.json", "utf8"))
    : { queries: [], oracle: {} };
const oracle = {
    ...JSON.parse(
      await readFile("work/global-bench/competitive-oracle.json", "utf8"),
    ),
    ...heldout.oracle,
  },
  queries = [
    ...demoWorkload,
    ...globalQueries.filter((q) => !demoWorkload.some((p) => p.q === q.q)),
    ...heldout.queries,
  ],
  rows: any[] = [],
  health: Record<string, unknown> = {};
let seed = 20261112;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 2 ** 32;
};
function shuffle<T>(a: T[]) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
await mkdir("work/columnar-bench", { recursive: true });
for (const name of variants) {
  const r = await fetch(`https://${name}.phulin.workers.dev/health`);
  if (!r.ok) throw Error("Health " + name + " " + r.status);
  health[name] = await r.json();
}
const manifest = {
  label,
  condition,
  seed: 20261112,
  sessions,
  repeats,
  variants,
  health,
  client: {
    region: process.env.CWS_CLIENT_REGION ?? "local-New-England",
    node: process.version,
  },
  startedAt: new Date().toISOString(),
  harnessSha256: createHash("sha256")
    .update(await readFile("bench/columnar/live.ts"))
    .digest("hex"),
};
async function call(
  name: string,
  q: string,
  session: number,
  repeat: number,
  warmup = false,
) {
  const requestId = randomUUID(),
    start = performance.now();
  let row: any;
  try {
    const r = await fetch(
      `https://${name}.phulin.workers.dev/search?requestId=${requestId}&q=${encodeURIComponent(q)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          q,
          limit: 20,
          resetMemory: condition !== "memory-reuse",
          ...(condition === "fresh-namespace"
            ? { cacheNamespace: `${label}-${session}` }
            : {}),
        }),
        signal: AbortSignal.timeout(120000),
      },
    );
    const body = await r.text(),
      ms = performance.now() - start;
    if (!r.ok) throw Error("HTTP " + r.status + ": " + body.slice(0, 500));
    const result = JSON.parse(body),
      want = oracle[q];
    if (
      result.results.length !== want.length ||
      result.results.some(
        (h: any, i: number) =>
          h.id !== want[i].id ||
          Math.abs(h.score - want[i].score) >
            1e-11 * Math.max(1, Math.abs(want[i].score)) ||
          JSON.stringify([h.title, h.metadata]) !==
            JSON.stringify([want[i].title, want[i].metadata]),
      )
    )
      throw Error("Oracle mismatch " + q);
    if (
      result.results.some(
        (h: any) => typeof (h.snippet ?? h.excerpt) !== "string",
      )
    )
      throw Error("Missing complete-response snippet");
    row = {
      name,
      q,
      kind: queries.find((x) => x.q === q)?.kind,
      session,
      repeat,
      warmup,
      requestId,
      ms,
      status: r.status,
      bytes: body.length,
      diagnostics: result.diagnostics,
      telemetry: result.telemetry,
      colo: result.colo,
    };
  } catch (e) {
    row = {
      name,
      q,
      session,
      repeat,
      warmup,
      requestId,
      ms: performance.now() - start,
      error: String(e),
    };
  }
  rows.push(row);
  if (!warmup)
    console.log(
      session,
      repeat,
      name,
      q,
      Math.round(row.ms),
      row.error ?? row.diagnostics?.requests,
    );
  return row;
}
const save = async () => {
  await writeFile(
    `work/columnar-bench/${label}.json.gz`,
    gzipSync(JSON.stringify({ manifest, rows })),
  );
};
try {
  for (let session = 0; session < sessions; session++) {
    if (condition !== "fresh-namespace")
      for (const q of shuffle(queries))
        for (const name of shuffle(variants))
          await call(name, q.q, session, -1, true);
    for (let repeat = 0; repeat < repeats; repeat++)
      for (const q of shuffle(queries)) {
        for (const name of shuffle(variants)) {
          const row = await call(name, q.q, session, repeat);
          if (row.error) throw Error(row.error);
        }
        await save();
      }
  }
} finally {
  await save();
}
