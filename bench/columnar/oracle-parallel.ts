import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { benchmarkToken } from "./token.js";
const [dir, out] = process.argv.slice(2);
if (!out) throw Error("Use INDEX_DIR OUTPUT.json");
const width = Number(
    process.env.CWS_ORACLE_WORKERS ??
      Math.min(8, Math.max(2, availableParallelism() - 2)),
  ),
  sourceUrl =
    process.env.CWS_BUILD_URL ??
    "https://work-search-cws-build-0.phulin.workers.dev",
  started = performance.now(),
  token = await benchmarkToken(),
  stagingPath = dir + "/oracle-scoring-root.json",
  finalRootPath = process.env.CWS_ORACLE_FINAL_ROOT ?? dir + "/root.json",
  partsDir = out + ".parts";
await mkdir(partsDir, { recursive: true });
let root: any;
for (;;) {
  const complete = await readFile(finalRootPath, "utf8").then(
    JSON.parse,
    () => undefined,
  );
  if (complete) {
    root = complete;
    break;
  }
  const scoring = await readFile(dir + "/scoring-root.json", "utf8").then(
    JSON.parse,
    () => undefined,
  );
  if (scoring) {
    root = scoring;
    break;
  }
  const state = await readFile(dir + "/build.json", "utf8").then(
    JSON.parse,
    () => undefined,
  );
  if (state?.rootRef) {
    const ref = state.rootRef,
      response = await fetch(
        `https://work-search-cws-upload.phulin.workers.dev/${ref.key}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
    if (!response.ok) throw Error("Scoring root read " + response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (
      bytes.length !== ref.size ||
      createHash("sha256").update(bytes).digest("hex") !== ref.sha256
    )
      throw Error("Scoring root identity mismatch");
    root = JSON.parse(new TextDecoder().decode(bytes));
    break;
  }
  await new Promise((r) => setTimeout(r, 5000));
}
await writeFile(stagingPath, JSON.stringify(root));
if (!Number.isInteger(width) || width < 2 || width > 16 || width > root.count)
  throw Error("Invalid oracle parallelism");
const paths = Array.from({ length: width }, (_, i) => `${partsDir}/${i}.json`);
await Promise.all(
  paths.map(async (path, i) => {
    const first = Math.floor((i * root.count) / width),
      end = Math.floor(((i + 1) * root.count) / width);
    const saved = await readFile(path, "utf8").then(
      JSON.parse,
      () => undefined,
    );
    if (
      saved?.first === first &&
      saved?.next === end &&
      saved?.corpusHash === root.corpusHash
    )
      return;
    await new Promise<void>((ok, no) => {
      const child = spawn(
        "yarn",
        [
          "node",
          "--import",
          "tsx",
          "bench/columnar/oracle-large.ts",
          dir,
          "r2",
          path,
        ],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            CWS_ORACLE_ROOT: stagingPath,
            CWS_ORACLE_FIRST: String(first),
            CWS_ORACLE_END: String(end),
            CWS_BUILD_URL: sourceUrl,
          },
        },
      );
      child.once("error", no);
      child.once("exit", (code) =>
        code === 0 ? ok() : no(Error("Oracle part failed " + i)),
      );
    });
  }),
);
const parts = await Promise.all(
  paths.map(async (path) => JSON.parse(await readFile(path, "utf8"))),
);
let next = 0,
  bodySum = 0,
  titleSum = 0;
const names = parts[0].names,
  observed = new Float64Array(names.length),
  expected = parts[0].expectedDf;
for (const p of parts) {
  if (
    p.kind !== "independent-oracle-part" ||
    p.first !== next ||
    p.count !== p.next - p.first ||
    p.corpusHash !== root.corpusHash ||
    JSON.stringify(p.names) !== JSON.stringify(names) ||
    JSON.stringify(p.expectedDf) !== JSON.stringify(expected)
  )
    throw Error("Oracle part coverage or statistics mismatch");
  next = p.next;
  bodySum += p.bodySum;
  titleSum += p.titleSum;
  p.observedDf.forEach((df: number, i: number) => (observed[i] += df));
}
if (
  next !== root.count ||
  bodySum / next !== root.avgBody ||
  titleSum / next !== root.avgTitle
)
  throw Error("Independent global statistic mismatch");
names.forEach((name: string, i: number) => {
  if (observed[i] !== expected[i])
    throw Error("Independent DF mismatch " + name);
});
const scenarios = parts[0].plans.map((p: any, i: number) => {
  const limit = p.options?.limit ?? 20,
    start = (p.page ?? 0) * limit,
    k = limit + start,
    ranked = parts
      .flatMap((part) => {
        const q = part.plans[i];
        if (
          JSON.stringify([q.q, q.options, q.page]) !==
          JSON.stringify([p.q, p.options, p.page])
        )
          throw Error("Oracle query contract mismatch");
        return q.ranked;
      })
      .sort((a, b) => b.score - a.score || a.doc - b.doc)
      .slice(0, k),
    last = start ? ranked[Math.min(start, ranked.length) - 1] : undefined;
  // Every global top-K member belongs to the top K of its own disjoint range.
  return {
    q: p.q,
    kind: p.kind,
    ...(last ? { cursorPredecessor: last } : {}),
    options: {
      ...p.options,
      ...(last ? { after: { score: last.score, doc: last.doc } } : {}),
    },
    oracle: ranked.slice(start, start + limit),
  };
});
console.log("Independent scan complete; waiting for the serving root");
let complete: any;
for (;;) {
  complete = await readFile(finalRootPath, "utf8").then(
    JSON.parse,
    () => undefined,
  );
  if (complete) break;
  await new Promise((r) => setTimeout(r, 5000));
}
if (
  JSON.stringify([
    complete.corpusHash,
    complete.count,
    complete.avgBody,
    complete.avgTitle,
    complete.hot,
    complete.dictionaries,
    complete.dictionaryHeight,
  ]) !==
    JSON.stringify([
      root.corpusHash,
      root.count,
      root.avgBody,
      root.avgTitle,
      root.hot,
      root.dictionaries,
      root.dictionaryHeight,
    ]) ||
  JSON.stringify(complete.objects.slice(0, root.objects.length)) !==
    JSON.stringify(root.objects) ||
  JSON.stringify(complete.objectIds?.slice(0, root.objects.length)) !==
    JSON.stringify(root.objectIds)
)
  throw Error("Published scoring data changed during validation");
await writeFile(
  out,
  JSON.stringify({
    generation: complete.generation,
    corpusHash: root.corpusHash,
    count: root.count,
    independentDfVerified: true,
    independentGlobalStatsVerified: true,
    oracleMs: performance.now() - started,
    parallelism: width,
    scenarios,
  }),
);
console.log("Independent parallel oracle complete", root.count);
