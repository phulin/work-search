import {
  readFile,
  writeFile,
  mkdir,
  rename,
  appendFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { benchmarkToken } from "./token.js";
import { queryTerms, parse } from "../../src/query/parser.js";
import { ColumnarIndex } from "../../src/columnar/search.js";
import { Reader } from "../../src/columnar/storage.js";
import { TermDirectory } from "../../src/columnar/term-directory.js";
import { OfflineObjects } from "../../src/columnar/offline.js";
import { constructionHTTP } from "../../scripts/construction-http.js";
import type { OracleConfiguration } from "./oracle-worker.js";
import { demoWorkload } from "../demo-workload.js";
import { globalQueries } from "../global-workload.js";

const [dir, definitions, out] = process.argv.slice(2),
  width = Number(process.env.CWS_ORACLE_WORKERS ?? 16),
  url =
    process.env.CWS_BUILD_URL ??
    "https://work-search-cws-build-0.phulin.workers.dev",
  uploader = "https://work-search-cws-upload.phulin.workers.dev",
  token = await benchmarkToken(),
  started = performance.now();
if (!out || !Number.isInteger(width) || width < 1 || width > 64)
  throw Error(
    "Usage: oracle-in-workers.ts INDEX_DIR CONTRACTS.json|regression OUTPUT.json",
  );
const regression = JSON.parse(
  await readFile("bench/columnar/query-contract.json", "utf8"),
);
const rootFile =
  dir +
  (process.argv.includes("--scoring-root")
    ? "/scoring-root.json"
    : "/root.json");
if (process.argv.includes("--wait-for-scoring-root")) {
  if (!process.argv.includes("--scoring-root"))
    throw Error("--wait-for-scoring-root requires --scoring-root");
  for (;;) {
    const ready = await readFile(rootFile).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      },
    );
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }
}
const sourceRootBytes = await readFile(rootFile);
const root = JSON.parse(sourceRootBytes.toString()),
  contracts =
    definitions === "regression"
      ? [
          ...demoWorkload,
          ...globalQueries.filter(
            (q) => !demoWorkload.some((p) => p.q === q.q),
          ),
          ...regression.heldout,
          ...regression.contracts.map((c: any) => ({
            ...c,
            options: { ...c.options, after: undefined },
            page: c.kind.includes("pagination") ? 1 : 0,
          })),
        ]
      : JSON.parse(await readFile(definitions, "utf8")),
  sourceRoot = JSON.parse(
    await readFile("work/columnar-worker-build/source-root.json", "utf8"),
  ),
  headers = { authorization: `Bearer ${token}` },
  health = (await fetch(url + "/oracle-health", { headers }).then((r) =>
    r.json(),
  )) as any,
  hash = (bytes: Uint8Array | string) =>
    createHash("sha256").update(bytes).digest("hex");
if (
  !health.code ||
  health.sourceHash !== hash(JSON.stringify(sourceRoot)) ||
  root.corpusHash !== hash(JSON.stringify({ sourceRoot, count: root.count }))
)
  throw Error("Oracle source mismatch");
const names = [
    ...new Set<string>(
      contracts.flatMap((s: any) => queryTerms(parse(s.q, s.options?.mode))),
    ),
  ],
  objects = new OfflineObjects(dir, root, { url: uploader, token }),
  terms = await new ColumnarIndex(
    root,
    undefined,
    root.directory
      ? new TermDirectory(await readFile(dir + "/directory.bin"), root.count)
      : undefined,
  ).terms(names, new Reader(root, objects.source));
await objects.close();
const configuration: OracleConfiguration = {
    corpusHash: root.corpusHash,
    statistics: {
      count: root.count,
      avgBody: root.avgBody,
      avgTitle: root.avgTitle,
      names,
      df: names.map((n) => terms.get(n)?.df ?? 0),
    },
    contracts,
  },
  configurationHash = hash(JSON.stringify(configuration)),
  partsDir = out + ".native-parts",
  post = constructionHTTP(width);
await mkdir(partsDir, { recursive: true });
async function call(path: string, input: unknown) {
  let busyRetries = 0,
    transientRetries = 0;
  for (let retry = 0; ; retry++) {
    let busy = false,
      retryable = true;
    try {
      const response = await post(url + path, token, JSON.stringify(input)),
        text = await response.text();
      if (response.ok) return JSON.parse(text);
      busy = response.status === 503 && text.includes("capacity busy");
      retryable = response.status >= 500;
      throw Error("Oracle " + response.status + ": " + text.slice(0, 500));
    } catch (error) {
      await appendFile(
        partsDir + "/errors.jsonl",
        JSON.stringify({
          at: new Date().toISOString(),
          path,
          retry,
          error: String(error),
        }) + "\n",
      );
      if (!retryable || (busy ? ++busyRetries > 120 : ++transientRetries > 6))
        throw error;
      await new Promise((r) =>
        setTimeout(
          r,
          busy
            ? 500 + Math.random() * 1000
            : Math.min(10000, 500 * 2 ** (transientRetries - 1)),
        ),
      );
    }
  }
}
const configRef = await call("/stage", {
    build: "native-oracle-" + configurationHash.slice(0, 24),
    task: "configuration",
    value: configuration,
  }).then((r) => r.output),
  first = Number(process.env.CWS_ORACLE_FIRST ?? 0),
  end = Number(process.env.CWS_ORACLE_END ?? root.count);
if (
  !Number.isInteger(first) ||
  !Number.isInteger(end) ||
  first < 0 ||
  end <= first ||
  end > root.count
)
  throw Error("Invalid oracle range");
const statePath = partsDir + "/state.json",
  state = await readFile(statePath, "utf8").then(JSON.parse, () => ({
    code: health.code,
    configurationHash,
    first,
    end,
    startedAt: new Date().toISOString(),
    jobs: Array.from({ length: Math.ceil((end - first) / 4096) }, (_, i) => ({
      first: first + i * 4096,
      next: first + i * 4096,
      end: Math.min(end, first + (i + 1) * 4096),
      parts: [],
    })),
  }));
if (
  state.configurationHash !== configurationHash ||
  state.code !== health.code ||
  state.first !== first ||
  state.end !== end
)
  throw Error("Changed oracle run configuration");
let saving = Promise.resolve(),
  nextJob = 0,
  completed = state.jobs.reduce((n: number, j: any) => n + j.next - j.first, 0);
const save = () =>
  (saving = saving.then(async () => {
    await writeFile(statePath + ".writing", JSON.stringify(state));
    await rename(statePath + ".writing", statePath);
  }));
await Promise.all(
  Array.from({ length: width }, async () => {
    for (;;) {
      const i = nextJob++;
      if (i >= state.jobs.length) return;
      const job = state.jobs[i];
      while (job.next < job.end) {
        const result = await call("/oracle-scan", {
          configuration: configRef,
          first: job.next,
          end: job.end,
        });
        if (
          result.first !== job.next ||
          result.next <= job.next ||
          result.next > job.end ||
          result.telemetry.code !== health.code
        )
          throw Error("Native oracle coverage/code mismatch");
        const response = await fetch(uploader + "/" + result.output.key, {
            headers,
          }),
          bytes = new Uint8Array(await response.arrayBuffer());
        if (
          !response.ok ||
          bytes.length !== result.output.size ||
          hash(bytes) !== result.output.sha256
        )
          throw Error("Native oracle result checksum mismatch");
        const path = `${partsDir}/${job.next}.json.gz`;
        await writeFile(path, bytes);
        job.parts.push({ path, first: job.next, next: result.next });
        completed += result.next - job.next;
        job.next = result.next;
        await appendFile(
          partsDir + "/requests.jsonl",
          JSON.stringify(result) + "\n",
        );
        await save();
        if (i % 16 === 0 || completed === end - first)
          console.log("Native oracle", completed, "/", end - first);
      }
    }
  }),
);
const df = new Float64Array(names.length),
  plans = contracts.map((c: any) => ({ ...c, ranked: [] as any[] }));
let covered = first,
  bodySum = 0,
  titleSum = 0;
for (const job of state.jobs)
  for (const ref of job.parts) {
    const part = JSON.parse(gunzipSync(await readFile(ref.path)).toString());
    if (
      part.first !== covered ||
      part.next !== ref.next ||
      part.count !== part.next - part.first ||
      part.corpusHash !== root.corpusHash ||
      JSON.stringify(part.names) !== JSON.stringify(names) ||
      JSON.stringify(part.expectedDf) !==
        JSON.stringify(configuration.statistics.df)
    )
      throw Error("Oracle part mismatch");
    covered = part.next;
    bodySum += part.bodySum;
    titleSum += part.titleSum;
    part.observedDf.forEach((n: number, i: number) => (df[i] += n));
    plans.forEach((p: any, i: number) => {
      if (JSON.stringify(part.plans[i].q) !== JSON.stringify(p.q))
        throw Error("Oracle contract mismatch");
      p.ranked.push(...part.plans[i].ranked);
      p.ranked.sort((a: any, b: any) => b.score - a.score || a.doc - b.doc);
      p.ranked.length = Math.min(
        p.ranked.length,
        (p.options?.limit ?? 20) * ((p.page ?? 0) + 1),
      );
    });
  }
if (covered !== end) throw Error("Oracle incomplete coverage");
if (first !== 0 || end !== root.count) {
  await writeFile(
    out,
    JSON.stringify({
      kind: "independent-oracle-part",
      first,
      next: end,
      corpusHash: root.corpusHash,
      count: end - first,
      bodySum,
      titleSum,
      names,
      observedDf: [...df],
      expectedDf: configuration.statistics.df,
      plans,
    }),
  );
} else {
  if (
    bodySum / end !== root.avgBody ||
    titleSum / end !== root.avgTitle ||
    df.some((n, i) => n !== configuration.statistics.df[i])
  )
    throw Error("Independent source statistic mismatch");
  const scenarios = plans.map((p: any) => {
    const limit = p.options?.limit ?? 20,
      start = (p.page ?? 0) * limit,
      last = start ? p.ranked[Math.min(start, p.ranked.length) - 1] : undefined;
    return {
      q: p.q,
      kind: p.kind,
      ...(last ? { cursorPredecessor: last } : {}),
      options: {
        ...p.options,
        ...(last ? { after: { score: last.score, doc: last.doc } } : {}),
      },
      oracle: p.ranked.slice(start, start + limit),
    };
  });
  await writeFile(
    out,
    JSON.stringify({
      generation: root.generation,
      corpusHash: root.corpusHash,
      count: root.count,
      code: health.code,
      configurationHash,
      statisticsRoot: {
        kind: process.argv.includes("--scoring-root") ? "scoring" : "serving",
        sha256: hash(sourceRootBytes),
      },
      parallelism: width,
      independentDfVerified: true,
      independentGlobalStatsVerified: true,
      oracleMs: performance.now() - started,
      scenarios,
    }),
  );
}
console.log("Native independent oracle complete", covered - first);
