import {
  readFile,
  writeFile,
  mkdir,
  rename,
  appendFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { benchmarkToken } from "../bench/columnar/token.js";
import type { Root, Ref } from "../src/columnar/format.js";
import { planMerges } from "./construction-merge-plan.js";
import { vocabularyRoot } from "./construction-vocabulary-root.js";
import {
  generationFor,
  VERIFY_OBJECTS,
  type Run,
} from "../src/columnar/construction/runs.js";
import {
  OBJECT_GROUP,
  type Routing,
  type TermRange,
} from "../src/columnar/construction/finish.js";
const count = Number(process.argv[2] ?? 1000),
  out = process.argv[3] ?? `work/columnar-worker-${count}`,
  build = process.argv[4] ?? `parallel-${count}-v1`,
  width = Number(process.env.CWS_BUILD_CONCURRENCY ?? 8),
  token = await benchmarkToken();
const coordinatorHash = createHash("sha256")
  .update(await readFile(new URL(import.meta.url)))
  .update(
    await readFile(new URL("./construction-merge-plan.ts", import.meta.url)),
  )
  .update(
    await readFile(
      new URL("./construction-vocabulary-root.ts", import.meta.url),
    ),
  )
  .digest("hex");
const urls = [
  process.env.CWS_BUILD_URL ??
    "https://work-search-cws-build-0.phulin.workers.dev",
];
if (
  !Number.isInteger(count) ||
  count < 1 ||
  !Number.isInteger(width) ||
  width < 1 ||
  width > 128 ||
  !/^[a-z0-9-]{1,80}$/.test(build)
)
  throw Error("Usage: build-in-workers.ts COUNT OUTPUT BUILD_ID");
await mkdir(out, { recursive: true });
const health = await Promise.all(
  urls.map(async (url) => {
    const r = await fetch(url + "/health", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw Error("Builder health " + url);
    return r.json() as any;
  }),
);
if (
  health.some(
    (h) => h.code !== health[0].code || h.sourceHash !== health[0].sourceHash,
  ) ||
  count > health[0].sourceDocuments
)
  throw Error("Builder pool code or source mismatch");
const sourceRoot = JSON.parse(
    await readFile("work/columnar-worker-build/source-root.json", "utf8"),
  ),
  sourceHash = createHash("sha256")
    .update(JSON.stringify({ sourceRoot, count }))
    .digest("hex"),
  checkpoint = out + "/build.json";
const state = await readFile(checkpoint, "utf8").then(JSON.parse, () => ({
  format: "parallel-build-v2",
  build,
  code: health[0].code,
  sourceHash,
  count,
  startedAt: new Date().toISOString(),
  ingests: [],
  merges: [],
  postings: [],
  routingLevels: [],
  documents: [],
  vocabularies: [],
}));
if (
  state.format !== "parallel-build-v2" ||
  state.code !== health[0].code ||
  state.sourceHash !== sourceHash ||
  state.build !== build
)
  throw Error(
    "Build code or source changed; use another build directory and ID",
  );
let saving = Promise.resolve(),
  lastSaved = -Infinity;
function save(force = false) {
  // Completed R2 tasks are idempotent. At most one second of coordinator
  // progress needs replay after interruption; do not rewrite the whole build
  // descriptor for every small ingestion request.
  if (!force && performance.now() - lastSaved < 1000) return saving;
  lastSaved = performance.now();
  saving = saving.then(async () => {
    await writeFile(checkpoint + ".writing", JSON.stringify(state));
    await rename(checkpoint + ".writing", checkpoint);
  });
  return saving;
}
async function call(worker: number, path: string, input: any) {
  const url = urls[worker % urls.length];
  for (let retry = 0; ; retry++)
    try {
      const started = performance.now(),
        response = await fetch(url + path, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ build, ...input }),
          signal: AbortSignal.timeout(240000),
        }),
        text = await response.text();
      if (!response.ok)
        throw Error(`${path} ${response.status}: ${text.slice(0, 1000)}`);
      const result = JSON.parse(text),
        o = result.output;
      await appendFile(
        out + "/requests.jsonl",
        JSON.stringify({
          at: new Date().toISOString(),
          worker: url,
          path,
          task: input.task,
          clientMs: performance.now() - started,
          ...result,
          output: undefined,
          work: {
            processed: o?.processed,
            tokens: o?.tokens,
            bytes: o?.emitted,
            dictionaryRequests: o?.dictionaryRequests,
            dictionaryBytes: o?.dictionaryBytes,
            idHits: o?.idHits,
            idMisses: o?.idMisses,
            idCacheBytes: o?.idCacheBytes,
          },
        }) + "\n",
      );
      return o;
    } catch (e) {
      await appendFile(
        out + "/errors.jsonl",
        JSON.stringify({
          at: new Date().toISOString(),
          worker: url,
          path,
          task: input.task,
          retry,
          error: String(e),
        }) + "\n",
      );
      if (retry === 6) throw e;
      console.log("Retry", url, path, String(e));
      await new Promise((r) =>
        setTimeout(r, Math.min(10000, 500 * 2 ** retry)),
      );
    }
}
async function pool<T>(
  jobs: T[],
  f: (job: T, i: number, worker: number) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, jobs.length) }, (_, worker) =>
      (async () => {
        for (;;) {
          const i = next++;
          if (i >= jobs.length) return;
          await f(jobs[i], i, worker);
        }
      })(),
    ),
  );
}
const ingestRange = Math.min(
  4096,
  Math.max(128, Math.ceil(count / (width * 4 * 128)) * 128),
);
if (!state.ingests.length)
  for (let first = 0; first < count; first += ingestRange)
    state.ingests.push({
      first,
      end: Math.min(count, first + ingestRange),
      next: first,
      runs: [],
    });
await pool<any>(state.ingests, async (job, _i, worker) => {
  while (job.next < job.end) {
    const run = (await call(worker, "/ingest", {
      task: `ingest-${job.next}`,
      first: job.next,
      count: Math.min(128, job.end - job.next),
    })) as Run;
    if (run.first !== job.next || run.next <= job.next || run.next > job.end)
      throw Error("Invalid ingest continuation");
    job.runs.push(run);
    job.next = run.next;
    await save();
    console.log(
      "R2 ingest",
      state.ingests.reduce((n: number, j: any) => n + j.next - j.first, 0),
      "/",
      count,
    );
  }
});
let runs: Run[] = state.ingests
    .flatMap((j: any) => j.runs)
    .sort((a: Run, b: Run) => a.first - b.first),
  level = 0;
async function mergeStage(stage: number, jobs: any[], groups: Run[][]) {
  // Each document group is staged once even when many lexical jobs use it.
  const refs = new Map<number, any>();
  for (const job of jobs) if (job.runsRef) refs.set(job.group, job.runsRef);
  await pool(groups, async (group, i, worker) => {
    if (refs.has(i) || group.length === 1) return;
    refs.set(
      i,
      await call(worker, "/stage", {
        task: `merge-input-${stage}-${i}`,
        value: group,
      }),
    );
  });
  for (const job of jobs) job.runsRef ??= refs.get(job.group);
  await save();
  await pool<any>(jobs, async (job, i, worker) => {
    if (job.done) return;
    const group = groups[job.group];
    if (group.length === 1) {
      if (job.range) throw Error("A lexical merge needs at least two inputs");
      job.run = group[0];
      job.done = true;
      await save();
      return;
    }
    while (!job.done) {
      const task = `merge-${stage}-${i}-${job.step}`,
        o = await call(worker, "/merge", {
          task,
          runsRef: job.runsRef,
          stateTask: job.previous,
          range: job.range,
        });
      job.previous = task;
      job.chunks.push(...o.chunks);
      job.step++;
      job.done = o.state.done;
      if (job.done)
        job.run = {
          first: group[0].first,
          next: group.at(-1)!.next,
          count: group.reduce((n, r) => n + r.count, 0),
          bodyTokens: group.reduce((n, r) => n + r.bodyTokens, 0),
          titleTokens: group.reduce((n, r) => n + r.titleTokens, 0),
          chunks: job.chunks,
        };
      await save();
    }
    console.log("R2 merged", stage, i, "/", jobs.length);
  });
}
while (runs.length > 1) {
  const plan = planMerges(runs, width);
  state.merges[level] ??= plan.jobs.map((job) => ({
    ...job,
    step: 0,
    chunks: [],
  }));
  const jobs = state.merges[level],
    groups: Run[][] = [];
  for (const job of jobs)
    groups[job.group] ??= runs.slice(job.firstRun, job.endRun);
  await mergeStage(level, jobs, groups);
  level++;
  if (jobs[0].lexical === undefined) {
    runs = jobs.map((j: any) => j.run);
    continue;
  }
  let parts: any[] = jobs;
  if (groups.length > 1) {
    const lexical: Run[][] = [];
    for (const job of jobs) (lexical[job.lexical] ??= []).push(job.run);
    state.merges[level] ??= lexical.map((_, group) => ({
      group,
      step: 0,
      chunks: [],
    }));
    parts = state.merges[level];
    await mergeStage(level++, parts, lexical);
  }
  runs = [
    {
      first: runs[0].first,
      next: runs.at(-1)!.next,
      count: runs.reduce((n, r) => n + r.count, 0),
      bodyTokens: runs.reduce((n, r) => n + r.bodyTokens, 0),
      titleTokens: runs.reduce((n, r) => n + r.titleTokens, 0),
      chunks: parts.flatMap((j) => j.run.chunks),
    },
  ];
}
const run = runs[0],
  statistics = {
    count,
    avgBody: run.bodyTokens / count,
    avgTitle: run.titleTokens / count,
  };
if (!state.runRef) {
  state.runRef = await call(0, "/stage", { task: "final-run", value: run });
  await save();
}
if (!state.postings.length) {
  const target = Number(
      process.env.CWS_BUILD_TERM_BYTES ?? (count <= 10000 ? 2 : 32) * 1048576,
    ),
    starts: { first: { chunk: number; at: number }; firstTerm: number }[] = [];
  let ordinal = 1,
    bytes = 0;
  for (let i = 0; i < run.chunks.length; i++) {
    const chunk = run.chunks[i];
    if (chunk.terms === undefined)
      throw Error("Run lacks term boundary metadata");
    if (chunk.firstTerm && (!starts.length || bytes >= target)) {
      starts.push({
        first: { chunk: i, at: chunk.firstTerm.at },
        firstTerm: ordinal,
      });
      bytes = 0;
    }
    ordinal += chunk.terms;
    bytes += chunk.size;
  }
  state.terms = ordinal - 1;
  state.postings = starts.map((start, i) => ({
    group: i,
    range: { ...start, end: starts[i + 1]?.first } satisfies TermRange,
    objects: [],
    step: 0,
  }));
  await save();
}
await pool<any>(state.postings, async (job, i, worker) => {
  while (!job.done) {
    const task = `postings-${i}-${job.step}`,
      o = await call(worker, "/postings", {
        task,
        runRef: state.runRef,
        statistics,
        range: job.range,
        objectBase: job.group * OBJECT_GROUP + job.objects.length,
        stateTask: job.previous,
        compact: true,
        byteBudget: 32 * 1048576,
      });
    job.previous = task;
    job.step++;
    job.objects.push(...o.objects);
    job.done = o.state.done;
    if (job.done) {
      const s = o.state;
      job.routing = {
        dictionaries: s.dictionaries.at(-1),
        dictionaryHeight: s.dictionaries.length - 1,
        idRouting: {
          dictionaries: s.ids.dictionaries.at(-1),
          dictionaryHeight: s.ids.dictionaries.length - 1,
        },
        hot: s.hot,
      };
    }
    await save();
  }
  console.log("R2 posting range", i + 1, "/", state.postings.length);
});
let allJobs: any[] = [...state.postings],
  routing: Routing[] = state.postings.map((j: any) => j.routing),
  nextGroup = state.postings.length,
  routingLevel = 0;
if (!routing.length)
  routing = [
    {
      dictionaries: [],
      dictionaryHeight: 0,
      idRouting: { dictionaries: [], dictionaryHeight: 0 },
      hot: [],
    },
  ];
while (routing.length > 1) {
  if (!state.routingLevels[routingLevel])
    state.routingLevels[routingLevel] = Array.from(
      { length: Math.ceil(routing.length / 64) },
      (_, i) => ({ group: nextGroup + i, objects: [] }),
    );
  const inputs = routing,
    jobs = state.routingLevels[routingLevel];
  await pool<any>(jobs, async (job, i, worker) => {
    if (job.done) return;
    const o = await call(worker, "/routing", {
      task: `routing-${routingLevel}-${i}`,
      parts: inputs.slice(i * 64, i * 64 + 64),
      objectBase: job.group * OBJECT_GROUP,
    });
    job.objects = o.objects;
    job.routing = o.routing;
    job.done = true;
    await save();
  });
  allJobs.push(...jobs);
  nextGroup += jobs.length;
  routing = jobs.map((j: any) => j.routing);
  routingLevel++;
}
function objectDirectory(jobs: any[]) {
  const objects: Root["objects"] = [],
    objectIds: number[] = [];
  for (const job of [...jobs].sort((a, b) => a.group - b.group))
    for (let i = 0; i < job.objects.length; i++) {
      objectIds.push(job.group * OBJECT_GROUP + i);
      objects.push(job.objects[i]);
    }
  return { objects, objectIds };
}
const route = routing[0],
  root: Root = {
    format: "CWS1",
    generation: sourceHash,
    corpusHash: sourceHash,
    ...statistics,
    documents: Array.from(
      { length: Math.ceil(count / 4096) },
      () => [0, 0, 0] as Ref,
    ),
    dictionaries: route.dictionaries,
    dictionaryHeight: route.dictionaryHeight,
    hot: Object.fromEntries(route.hot),
    ...objectDirectory(allJobs),
  };
await writeFile(out + "/scoring-root.json", JSON.stringify(root));
if (!state.rootRef) {
  state.rootRef = await call(0, "/stage", {
    task: "dictionary-root",
    value: await vocabularyRoot(out, root, route.idRouting, token),
  });
  await save();
}
if (!state.vocabularies.length)
  for (let first = 0; first < count; first += 1024)
    state.vocabularies.push({
      first,
      end: Math.min(count, first + 1024),
      next: first,
      segments: [],
    });
await pool<any>(state.vocabularies, async (job, i, worker) => {
  while (job.next < job.end) {
    const o = await call(worker, "/vocabulary", {
      task: `vocabulary-${job.next}`,
      rootRef: state.rootRef,
      first: job.next,
      count: job.end - job.next,
    });
    if (o.first !== job.next || o.end <= job.next || o.end > job.end)
      throw Error("Invalid vocabulary continuation");
    job.segments.push({ first: o.first, end: o.end, ref: o.vocabulary });
    job.next = o.end;
    await save();
  }
  console.log("R2 vocabulary range", i + 1, "/", state.vocabularies.length);
});
if (!state.documents.length)
  for (let first = 0; first < count; first += 4096)
    state.documents.push({
      group: nextGroup + state.documents.length,
      range: { first, end: Math.min(count, first + 4096) },
      objects: [],
      step: 0,
    });
await pool<any>(state.documents, async (job, i, worker) => {
  while (!job.done) {
    const next = job.next ?? job.range.first,
      vocabulary = state.vocabularies[Math.floor(next / 1024)].segments.find(
        (s: any) => s.first <= next && next < s.end,
      );
    if (!vocabulary) throw Error("Missing completed document vocabulary");
    const task = `documents-${i}-${job.step}`,
      o = await call(worker, "/documents", {
        task,
        documentRoot: { generation: root.generation, count },
        vocabularyRef: vocabulary.ref,
        range: job.range,
        objectBase: job.group * OBJECT_GROUP + job.objects.length,
        stateTask: job.previous,
        compact: true,
      });
    job.previous = task;
    job.step++;
    job.objects.push(...o.objects);
    job.done = o.done;
    job.next = o.state.next;
    if (job.done) job.documents = o.state.documents;
    await save();
  }
  console.log("R2 document range", i + 1, "/", state.documents.length);
});
allJobs.push(...state.documents);
Object.assign(root, objectDirectory(allJobs));
root.documents = state.documents.flatMap((j: any) => j.documents);
root.generation = await generationFor(root);
await save(true);
await writeFile(out + "/root.json", JSON.stringify(root));
if (!state.finalRootRef) {
  state.finalRootRef = await call(0, "/stage", {
    task: "complete-root",
    value: root,
  });
  await save();
}
state.verifications ??= Array.from(
  { length: Math.ceil(root.objects.length / VERIFY_OBJECTS) },
  (_, i) => ({ first: i * VERIFY_OBJECTS, task: `verify-${i}`, done: false }),
);
await pool<any>(state.verifications, async (job, _i, worker) => {
  if (job.done) return;
  await call(worker, "/verify", {
    task: job.task,
    rootRef: state.finalRootRef,
    first: job.first,
  });
  job.done = true;
  await save();
});
await call(0, "/publish", {
  task: "publish-" + root.generation,
  rootRef: state.finalRootRef,
  verifications: state.verifications.map((j: any) => j.task),
});
await save(true);
await writeFile(
  out + "/manifest.json",
  JSON.stringify(
    {
      build,
      code: state.code,
      coordinatorHash,
      coordinatorFormat: state.format,
      sourceHash,
      sourceDocuments: sourceRoot.documents,
      count,
      terms: state.terms,
      bodyTokens: run.bodyTokens,
      titleTokens: run.titleTokens,
      generation: root.generation,
      objects: root.objects.length,
      bytes: root.objects.reduce((n, o) => n + o.size, 0),
      startedAt: state.startedAt,
      finishedAt: new Date().toISOString(),
      construction: "Cloudflare Workers and R2",
      workers: urls,
      concurrency: width,
      reusedConstruction: state.reusedConstruction,
      planningWidth: width,
      postingsJobs: state.postings.length,
      documentJobs: state.documents.length,
    },
    null,
    2,
  ),
);
console.log("Parallel Worker/R2 build complete", root.generation);
