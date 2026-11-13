import {
  readFile,
  writeFile,
  mkdir,
  rename,
  copyFile,
  appendFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { benchmarkToken } from "../bench/columnar/token.js";
import { constructionHTTP } from "./construction-http.js";
import { PairStatistics } from "../src/columnar/construction/pair-statistics.js";
import {
  generationFor,
  VERIFY_OBJECTS,
} from "../src/columnar/construction/runs.js";
import { OBJECT_GROUP } from "../src/columnar/construction/finish.js";
import type { Root } from "../src/columnar/format.js";
import { pairPacketByteBound } from "../src/columnar/pair-packet.js";
type SelectedPair = {
  key: number;
  a: number;
  b: number;
  df: number;
  occurrences: number;
  cost: number;
  utility: number;
};
// Accelerator selection is bounded independently of corpus pair vocabulary.
// Search completeness never depends on whether an accelerator is selected.
class SelectionHeap {
  rows: SelectedPair[] = [];
  worse(a: SelectedPair, b: SelectedPair) {
    return a.utility < b.utility || (a.utility === b.utility && a.key > b.key);
  }
  add(row: SelectedPair) {
    const a = this.rows;
    if (a.length === 65536) {
      if (!this.worse(a[0], row)) return;
      a[0] = row;
      let i = 0;
      for (;;) {
        let j = i * 2 + 1;
        if (j >= a.length) break;
        if (j + 1 < a.length && this.worse(a[j + 1], a[j])) j++;
        if (!this.worse(a[j], a[i])) break;
        [a[i], a[j]] = [a[j], a[i]];
        i = j;
      }
    } else {
      a.push(row);
      let i = a.length - 1;
      while (i) {
        const j = (i - 1) >>> 1;
        if (!this.worse(a[i], a[j])) break;
        [a[i], a[j]] = [a[j], a[i]];
        i = j;
      }
    }
  }
}

const [base, out, build] = process.argv.slice(2),
  budget =
    Number(process.argv[5]?.startsWith("--") ? 64 : (process.argv[5] ?? 64)) *
    1048576,
  reuseAt = process.argv.indexOf("--reuse-statistics"),
  width = Number(process.env.CWS_BUILD_CONCURRENCY ?? 8),
  url =
    process.env.CWS_BUILD_URL ??
    "https://work-search-cws-build-0.phulin.workers.dev",
  uploader = "https://work-search-cws-upload.phulin.workers.dev",
  token = await benchmarkToken();
if (
  !base ||
  !out ||
  !/^[a-z0-9-]{1,80}$/.test(build) ||
  !Number.isInteger(width) ||
  width < 1 ||
  width > 32 ||
  !Number.isFinite(budget) ||
  budget < 0
)
  throw Error(
    "Usage: build-pairs-in-workers.ts BASE_PACKET_BUILD OUTPUT BUILD_ID [BUDGET_MIB]",
  );
const root: Root = JSON.parse(await readFile(base + "/root.json", "utf8")),
  packages = JSON.parse(await readFile(base + "/build.json", "utf8")),
  health = (await fetch(url + (process.env.CWS_PAIR_HEALTH ?? "/health"), {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json())) as any;
if (
  !root.directory ||
  !root.documentPackages?.locators ||
  packages.packages.some((j: any) => j.next !== j.end)
)
  throw Error(
    "Pair construction requires a complete grouped packet generation",
  );
await mkdir(out, { recursive: true });
const stateFile = out + "/build.json",
  state = await readFile(stateFile, "utf8").then(JSON.parse, () => ({
    code: health.code,
    sourceGeneration: root.generation,
    startedAt: new Date().toISOString(),
    build,
    budget,
    statistics: [],
    occurrences: [],
    levels: {},
  }));
if (
  state.code !== health.code ||
  state.sourceGeneration !== root.generation ||
  state.build !== build ||
  state.budget !== budget
)
  throw Error(
    "Pair construction source or code changed; use a new output/build",
  );
const post = constructionHTTP(width);
const statisticsIO =
  process.env.CWS_PAIR_IO === "1"
    ? ((await fetch(url + "/pair-io-health", {
        headers: { authorization: `Bearer ${token}` },
      }).then((r) => r.json())) as any)
    : undefined;
if (statisticsIO) {
  if (statisticsIO.format !== "CPS1-stream-v1")
    throw Error("Invalid streamed statistics I/O endpoint");
  state.statisticsIOCode = statisticsIO.code;
}
if (reuseAt >= 0 && !state.statistics.length) {
  const previous = JSON.parse(
    await readFile(process.argv[reuseAt + 1] + "/build.json", "utf8"),
  );
  if (
    previous.code !== health.code ||
    previous.sourceGeneration !== root.generation ||
    !previous.selection
  )
    throw Error(
      "Statistics reuse requires matching, completed corpus statistics",
    );
  state.vocabulary = previous.vocabulary;
  state.vocabularyRef = previous.vocabularyRef;
  state.statistics = previous.statistics;
  state.levels = Object.fromEntries(
    Object.entries(previous.levels).filter(([key]) =>
      key.startsWith("statistics-"),
    ),
  );
  state.reusedStatisticsBuild = previous.build;
}
let saving = Promise.resolve(),
  lastSaved = -Infinity;
function save(force = false) {
  if (!force && performance.now() - lastSaved < 1000) return saving;
  lastSaved = performance.now();
  saving = saving.then(async () => {
    await writeFile(stateFile + ".writing", JSON.stringify(state));
    await rename(stateFile + ".writing", stateFile);
  });
  return saving;
}
async function call(
  path: string,
  task: string,
  value: any = {},
  targetBuild = build,
) {
  let busyRetries = 0,
    transientRetries = 0;
  for (let retry = 0; ; retry++) {
    const started = performance.now();
    let busy = false;
    try {
      const response = await post(
          url + path,
          token,
          JSON.stringify({ build: targetBuild, task, ...value }),
        ),
        text = await response.text();
      busy = response.status === 503 && text.includes("capacity busy");
      if (!response.ok)
        throw Error(path + " " + response.status + ": " + text.slice(0, 1000));
      const result = JSON.parse(text);
      await appendFile(
        out + "/requests.jsonl",
        JSON.stringify({
          at: new Date().toISOString(),
          path,
          task,
          clientMs: performance.now() - started,
          ...result,
          output: undefined,
        }) + "\n",
      );
      return result.output;
    } catch (error) {
      if (busy ? ++busyRetries > 60 : ++transientRetries > 6) throw error;
      console.log("Retry", path, task, String(error));
      await new Promise((r) =>
        setTimeout(
          r,
          (busy ? 500 : Math.min(10000, 500 * 2 ** (transientRetries - 1))) *
            (0.75 + Math.random() * 0.5),
        ),
      );
    }
  }
}
async function pool<T>(jobs: T[], run: (job: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, jobs.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        await run(jobs[i], i);
      }
    }),
  );
}
if (!state.vocabulary) {
  await new Promise<void>((ok, no) => {
    const child = spawn(
      "yarn",
      [
        "node",
        "--import",
        "tsx",
        "scripts/select-pair-vocabulary.ts",
        base,
        base + "/root.json",
        "65536",
      ],
      { stdio: "inherit" },
    );
    child.once("error", no);
    child.once("exit", (c) =>
      c === 0 ? ok() : no(Error("Pair vocabulary selection failed")),
    );
  });
  state.vocabulary = JSON.parse(
    await readFile(base + "/pair-vocabulary.json", "utf8"),
  );
  state.vocabularyRef = await call("/stage", "vocabulary", {
    value: state.vocabulary,
  });
  await save(true);
}
const groups = packages.packages
  .flatMap((j: any) => j.groups)
  .sort((a: any, b: any) => a.first - b.first);
await pool<any>(groups, async (group, i) => {
  if (!state.statistics[i]) {
    state.statistics[i] = await call("/pair-statistics", `statistics-${i}`, {
      vocabularyRef: state.vocabularyRef,
      group,
    });
    await save();
  }
  if (i % 100 === 0) console.log("Pair statistics", i + 1, "/", groups.length);
});
async function merge(kind: "statistics" | "occurrences", inputs: any[]) {
  let runs = inputs,
    level = 0;
  while (runs.length > 1) {
    const jobs = Array.from({ length: Math.ceil(runs.length / 4) }, (_, i) =>
        runs.slice(i * 4, i * 4 + 4),
      ),
      outputs = (state.levels[`${kind}-${level}`] ??= []);
    state.levels[`${kind}-${level}`] = outputs;
    await pool(jobs, async (batch, i) => {
      if (!outputs[i]) {
        const task = `${kind}-merge-${level}-${i}`,
          bytes = batch.reduce(
            (n, run) =>
              n + run.chunks.reduce((s: number, c: any) => s + c.size, 0),
            0,
          );
        if (kind === "occurrences" && bytes > 64 * 1048576) {
          const rangeState = ((state.rangeMerges ??= {})[task] ??= {
            outputs: [],
          });
          if (!rangeState.runs) {
            rangeState.runs = batch.every((r) =>
              r.chunks.every((c: any) => c.firstKey !== undefined),
            )
              ? batch
              : (
                  await call("/pair-restarts", task + "-restarts", {
                    runs: batch,
                  })
                ).runs;
            const pairs = state.selection.pairs,
              n = Math.min(32, Math.ceil(bytes / (32 * 1048576))),
              target = pairs.reduce((s: number, p: any) => s + p.cost, 0) / n;
            const boundaries = [0];
            let cumulative = 0;
            for (let j = 0; j + 1 < pairs.length; j++) {
              cumulative += pairs[j].cost;
              if (
                cumulative >= target * boundaries.length &&
                boundaries.length < n
              )
                boundaries.push(pairs[j + 1].key);
            }
            boundaries.push(2 ** 32);
            rangeState.ranges = boundaries
              .slice(1)
              .map((endKey, j) => ({ firstKey: boundaries[j], endKey }));
            await save(true);
          }
          await pool<any>(rangeState.ranges, async (range, j) => {
            if (rangeState.outputs[j]) return;
            rangeState.outputs[j] = (
              await call(
                "/merge-pair-occurrences-range",
                task + "-range-" + j,
                { runs: rangeState.runs, range },
              )
            ).run;
            await save();
          });
          outputs[i] = {
            first: batch[0].first,
            end: batch.at(-1)!.end,
            selection: batch[0].selection,
            chunks: rangeState.outputs.flatMap((r: any) => r.chunks),
          };
          await save();
          return;
        }
        const result = await call(
          kind === "statistics" && statisticsIO
            ? "/merge-pair-statistics-io"
            : `/merge-pair-${kind}`,
          task,
          { runs: batch },
        );
        outputs[i] = kind === "occurrences" ? result.run : result;
        await save();
      }
    });
    runs = outputs;
    level++;
    console.log("Pair", kind, "merge", level, "runs", runs.length);
  }
  return runs[0];
}
const statistics = await merge("statistics", state.statistics);
if (!state.selection) {
  if (statistics.first !== 0 || statistics.end !== root.count)
    throw Error("Incomplete pair statistics corpus");
  const terms = state.vocabulary.terms,
    width = terms.length,
    heap = new SelectionHeap();
  let lastKey = -1;
  for (const chunk of statistics.chunks) {
    const response = await fetch(`${uploader}/${chunk.key}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw Error("Pair statistics download failed");
    const statisticsBytes = new Uint8Array(await response.arrayBuffer());
    if (
      statisticsBytes.length !== chunk.size ||
      createHash("sha256").update(statisticsBytes).digest("hex") !==
        chunk.sha256
    )
      throw Error("Pair statistics content mismatch");
    const stats = new PairStatistics(statisticsBytes);
    if (
      stats.first !== 0 ||
      stats.end !== root.count ||
      (stats.count && stats.key(0) <= lastKey)
    )
      throw Error("Pair statistics stream coverage/order mismatch");
    for (let i = 0; i < stats.count; i++) {
      const key = stats.key(i),
        a = terms[Math.floor(key / width)],
        b = terms[key % width],
        df = stats.df(i),
        occurrences = stats.occurrences(i),
        anchor = Math.min(a.df, b.df),
        cost = pairPacketByteBound(df, occurrences);
      if (
        anchor < Math.min(1024, root.count / 8) ||
        df * 2 >= anchor ||
        cost > 2 * 1048576
      )
        continue;
      const saved =
        (anchor - df) * root.avgBody +
        Math.max(
          0,
          Math.min(
            a.bodyOccurrences + a.titleOccurrences,
            b.bodyOccurrences + b.titleOccurrences,
          ) - occurrences,
        );
      heap.add({
        key,
        a: a.id,
        b: b.id,
        df,
        occurrences,
        cost,
        utility: (saved * occurrences) / cost,
      });
    }
    if (stats.count) lastKey = stats.key(stats.count - 1);
  }
  const ranked = heap.rows;
  ranked.sort((a, b) => b.utility - a.utility || a.key - b.key);
  const pairs = [];
  let bytes = 0;
  for (const p of ranked)
    if (pairs.length < 4096 && bytes + p.cost <= budget) {
      pairs.push(p);
      bytes += p.cost;
    }
  pairs.sort((a, b) => a.key - b.key);
  state.selection = {
    corpusHash: root.corpusHash,
    directorySha256: root.directory.sha256,
    documents: root.count,
    terms,
    pairs,
    budget,
    estimatedBytes: bytes,
    selection:
      "Up to 4096 corpus pairs from the highest 65536 occurrence-weighted avoided-verification utilities per conservative packet byte; no query inputs",
  };
  await writeFile(out + "/selection.json", JSON.stringify(state.selection));
  state.selectionRef = await call("/stage", "selection", {
    value: state.selection,
  });
  await save(true);
  console.log(
    "Selected positional pairs",
    pairs.length,
    "estimated bytes",
    bytes,
  );
}
await pool<any>(groups, async (group, i) => {
  if (!state.occurrences[i]) {
    state.occurrences[i] = (
      await call("/pair-occurrences", `occurrences-${i}`, {
        selectionRef: state.selectionRef,
        group,
      })
    ).runs;
    await save();
  }
  if (i % 100 === 0) console.log("Pair occurrences", i + 1, "/", groups.length);
});
const run = await merge("occurrences", state.occurrences.flat()),
  objectBase =
    Math.ceil(
      ((root.objectIds?.at(-1) ?? root.objects.length - 1) + 1) / OBJECT_GROUP,
    ) * OBJECT_GROUP;
if (!state.finishedPairs) {
  state.finishedPairs = await call("/finish-pairs", "finish", {
    selectionRef: state.selectionRef,
    run,
    objectBase,
  });
  await save(true);
}
const pairs = state.finishedPairs,
  paired: Root = {
    ...root,
    generation: "",
    objects: [...root.objects, ...pairs.objects],
    objectIds: [
      ...(root.objectIds ?? root.objects.map((_, i) => i)),
      ...pairs.objects.map((_: any, i: number) => objectBase + i),
    ],
    positionalPairs: pairs.descriptors,
  };
paired.generation = await generationFor(paired);
await writeFile(out + "/root.json", JSON.stringify(paired));
for (const file of ["directory.bin", "documents.bin"])
  await copyFile(base + "/" + file, out + "/" + file);
// Existing package acknowledgements remain authoritative. New publication work
// is stored under the source build so it can validate those unchanged packages.
const publishBuild = packages.build,
  newRootRef = await call("/stage", "paired-root", { value: paired }),
  verifications = [];
for (let first = 0; first < paired.objects.length; first += VERIFY_OBJECTS)
  verifications.push(
    `paired-${paired.generation.slice(0, 12)}-verify-${first}`,
  );
async function publishCall(path: string, task: string, value: any) {
  return call(path, task, value, publishBuild);
}
await pool(verifications, async (task, i) => {
  await publishCall("/verify", task, {
    rootRef: newRootRef,
    first: i * VERIFY_OBJECTS,
  });
});
const packageTasks = packages.packages.flatMap((j: any) => j.tasks),
  coverage = Array.from(
    { length: Math.ceil(packageTasks.length / 256) },
    (_, i) => `coverage-${i * 256}`,
  );
await publishCall(
  "/publish",
  `paired-${paired.generation.slice(0, 12)}-publish`,
  { rootRef: newRootRef, verifications, packageVerifications: coverage },
);
state.finishedAt = new Date().toISOString();
await save(true);
await writeFile(
  out + "/manifest.json",
  JSON.stringify(
    {
      build,
      code: health.code,
      baseGeneration: root.generation,
      generation: paired.generation,
      corpusHash: root.corpusHash,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      coverage: pairs.coverage,
      workers: [url],
      concurrency: width,
      reusedStatisticsBuild: state.reusedStatisticsBuild,
      statisticsIOCode: state.statisticsIOCode,
    },
    null,
    2,
  ),
);
console.log(
  "Native positional pairs complete",
  paired.generation,
  pairs.coverage,
);
