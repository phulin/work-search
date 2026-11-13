import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { benchmarkToken } from "./token.js";
import { demoWorkload } from "../demo-workload.js";
import { globalQueries } from "../global-workload.js";
const variants = (
    process.env.CWS_VARIANTS ?? "work-search-cws-control,work-search-cws-v3"
  ).split(","),
  label = process.env.CWS_LABEL ?? "load",
  condition = process.env.CWS_CONDITION ?? "memory-reuse",
  count = Number(process.env.CWS_REQUESTS ?? 10000),
  rate = Number(process.env.CWS_RATE ?? 4),
  cap = Number(process.env.CWS_CONCURRENCY ?? 32),
  sessions = Number(process.env.CWS_SESSIONS ?? 3),
  token = await benchmarkToken();
const heldout = JSON.parse(
    await readFile("work/columnar-bench/heldout.json", "utf8"),
  ),
  oracle = {
    ...JSON.parse(
      await readFile("work/global-bench/competitive-oracle.json", "utf8"),
    ),
    ...heldout.oracle,
  };
const queries = [
    ...demoWorkload,
    ...globalQueries.filter((q) => !demoWorkload.some((p) => p.q === q.q)),
    ...heldout.queries,
    ...(await readFile("work/columnar-bench/contracts.json", "utf8").then(
      JSON.parse,
      () => [],
    )),
  ],
  rows: any[] = [],
  health: Record<string, any> = {};
const externalScenarios = process.env.CWS_SCENARIOS
  ? JSON.parse(await readFile(process.env.CWS_SCENARIOS, "utf8"))
  : undefined;
if (externalScenarios) {
  queries.splice(0, queries.length, ...externalScenarios.scenarios);
}
let seed = 20261112;
const rand = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 2 ** 32;
};
function shuffle<T>(a: T[]) {
  a = [...a];
  for (let i = a.length - 1; i; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const sleep = (ms: number) =>
  new Promise((r) => setTimeout(r, Math.max(0, ms)));
const clientWorker = process.env.CWS_CLIENT_WORKER;
const resolvedCursors = new Map<string, { score: number; doc: number }>();
await mkdir("work/columnar-bench", { recursive: true });
for (const name of variants) {
  const r = await fetch(`https://${name}.phulin.workers.dev/health`);
  if (!r.ok) throw Error("Health " + name);
  health[name] = await r.json();
  if (
    externalScenarios &&
    health[name].generation !== externalScenarios.generation
  )
    throw Error("Scenario generation mismatch " + name);
  if (externalScenarios)
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i] as any;
      if (!query.options?.after) continue;
      // libm and V8 can differ in the last score bits. A search-after cursor
      // must come from this executor, after independently checking its rank.
      const response = await fetch(
        `https://${name}.phulin.workers.dev/search`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            q: query.q,
            ...query.options,
            after: undefined,
            resetMemory: true,
          }),
        },
      );
      const result = (await response.json()) as any,
        last = result.results?.at(-1),
        expected = query.cursorPredecessor ?? query.options.after;
      if (
        !response.ok ||
        !last ||
        last.doc !== expected.doc ||
        (expected.id !== undefined && last.id !== expected.id) ||
        Math.abs(last.score - expected.score) >
          1e-11 * Math.max(1, Math.abs(expected.score))
      )
        throw Error(
          "Independent cursor predecessor mismatch " + name + ":" + i,
        );
      resolvedCursors.set(`${name}:${i}`, { score: last.score, doc: last.doc });
    }
}
const manifest = {
  clientWorker,
  regionalHealth: clientWorker
    ? await fetch(`https://${clientWorker}.phulin.workers.dev/health`, {
        headers: { authorization: `Bearer ${token}` },
      }).then(async (r) => ({
        ...((await r.json()) as object),
        placement: r.headers.get("cf-placement"),
      }))
    : undefined,
  finishedAt: undefined as string | undefined,
  label,
  condition,
  countPerVariant: count,
  totalRate: rate,
  clientConcurrencyLimit: cap,
  sessions,
  seed,
  queries,
  health,
  clientRegion: process.env.CWS_CLIENT_REGION ?? "local-New-England",
  node: process.version,
  startedAt: new Date().toISOString(),
  harnessSha256: createHash("sha256")
    .update(await readFile("bench/columnar/load.ts"))
    .digest("hex"),
  responseCaching: false,
  resolvedCursors: Object.fromEntries(resolvedCursors),
};
async function call(
  name: string,
  query: {
    q: string;
    kind: string;
    options?: Record<string, unknown>;
    oracle?: any[];
  },
  session: number,
  scheduled: number,
  warmup = false,
) {
  const requestId = randomUUID(),
    started = performance.now(),
    row: any = {
      name,
      q: query.q,
      kind: query.kind,
      options: query.options,
      session,
      warmup,
      requestId,
      arrivalLatenessMs: Math.max(0, started - scheduled),
      startedAt: new Date().toISOString(),
    };
  try {
    const options = {
      q: query.q,
      limit: 20,
      ...query.options,
      ...(resolvedCursors.has(`${name}:${queries.indexOf(query)}`)
        ? { after: resolvedCursors.get(`${name}:${queries.indexOf(query)}`) }
        : {}),
      ...(query.options?.after ? { generation: health[name].generation } : {}),
      resetMemory: condition !== "memory-reuse",
      ...(condition === "fresh-namespace"
        ? { cacheNamespace: `${label.slice(0, 20)}-${requestId}` }
        : {}),
    };
    const r = await fetch(
      clientWorker
        ? `https://${clientWorker}.phulin.workers.dev/search`
        : `https://${name}.phulin.workers.dev/search?requestId=${requestId}&q=${encodeURIComponent(query.q)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(
          clientWorker ? { name, q: query.q, options, requestId } : options,
        ),
        signal: AbortSignal.timeout(120000),
      },
    );
    const text = await r.text();
    row.ms = performance.now() - started;
    row.completeMs = performance.now() - scheduled;
    row.status = r.status;
    row.workerPlacement = r.headers.get("cf-placement");
    row.bytes = Buffer.byteLength(text);
    if (!r.ok) {
      row.error = `HTTP ${r.status}: ${text.slice(0, 500)}`;
      return row;
    }
    const parseStart = performance.now(),
      envelope = JSON.parse(text);
    if (!clientWorker) {
      row.parseMs = performance.now() - parseStart;
      row.ms = performance.now() - started;
      row.completeMs = performance.now() - scheduled;
    }
    if (clientWorker) {
      row.clientPlacement = r.headers.get("cf-placement");
      row.driverRoundtripMs = row.ms;
      row.ms = envelope.clientMs;
      row.completeMs = envelope.clientMs;
      row.status = envelope.status;
      row.clientColo = envelope.clientRequestColo;
      if (envelope.status !== 200) {
        row.error = JSON.stringify(envelope.body);
        return row;
      }
    }
    const result = clientWorker ? envelope.body : envelope,
      want = query.oracle ?? oracle[query.q];
    row.diagnostics = result.diagnostics;
    row.telemetry = result.telemetry;
    row.colo = result.colo;
    row.correct =
      result.results.length === want.length &&
      result.results.every(
        (h: any, i: number) =>
          h.id === want[i].id &&
          Math.abs(h.score - want[i].score) <=
            1e-11 * Math.max(1, Math.abs(want[i].score)) &&
          JSON.stringify([h.title, h.metadata]) ===
            JSON.stringify([want[i].title, want[i].metadata]) &&
          typeof (h.snippet ?? h.excerpt) === "string",
      );
    if (!row.correct) {
      row.error = "Oracle mismatch";
      row.mismatch = {
        got: result.results.map((h: any) => ({ id: h.id, score: h.score })),
        want: want.map((h: any) => ({ id: h.id, score: h.score })),
      };
    }
  } catch (e) {
    row.ms = performance.now() - started;
    row.completeMs = performance.now() - scheduled;
    row.error = String(e);
  } finally {
    rows.push(row);
  }
  return row;
}
const save = () =>
  writeFile(
    `work/columnar-bench/${label}.json.gz`,
    gzipSync(JSON.stringify({ manifest, rows })),
  );
let done = 0;
try {
  for (let session = 0; session < sessions; session++) {
    if (condition !== "fresh-namespace")
      for (const query of shuffle(queries))
        for (const name of shuffle(variants)) {
          const row = await call(name, query, session, performance.now(), true);
          if (row.error) console.log("Warmup error", name, query.q, row.error);
          await save();
        }
    const n =
        Math.floor(count / sessions) + (session < count % sessions ? 1 : 0),
      jobs = [];
    let selected = shuffle(queries);
    for (let i = 0; i < n; i++) {
      if (i && i % queries.length === 0) selected = shuffle(queries);
      const query = selected[i % queries.length];
      for (const name of shuffle(variants)) jobs.push({ name, query });
    }
    const active = new Set<Promise<unknown>>(),
      start = performance.now();
    for (let i = 0; i < jobs.length; i++) {
      const scheduled = start + (i * 1000) / rate;
      await sleep(scheduled - performance.now());
      if (active.size >= cap) await Promise.race(active);
      const { name, query } = jobs[i];
      const task = call(name, query, session, scheduled)
        .then((row) => {
          if (!row.warmup && ++done % 100 === 0)
            console.log(
              label,
              session,
              done,
              "last",
              name,
              Math.round(row.ms),
              row.status,
              row.error ?? "",
            );
        })
        .finally(() => active.delete(task));
      active.add(task);
      if (i % 500 === 0) await save();
    }
    await Promise.all(active);
    await save();
  }
} finally {
  manifest.finishedAt = new Date().toISOString();
  await save();
}
if (rows.some((r) => !r.warmup && r.correct === false))
  throw Error("Correctness failure; raw responses must be investigated");
