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
import type { Run } from "../src/columnar/construction/runs.js";
import { generationFor } from "../src/columnar/construction/runs.js";
const count = Number(process.argv[2] ?? 1000),
  out = process.argv[3] ?? `work/columnar-worker-${count}`,
  build = process.argv[4] ?? `worker-${count}-v1`,
  url =
    process.env.CWS_BUILD_URL ??
    "https://work-search-cws-build-0.phulin.workers.dev",
  token = await benchmarkToken();
if (!Number.isInteger(count) || count < 1 || !/^[a-z0-9-]{1,80}$/.test(build))
  throw Error("Usage: build-in-workers.ts COUNT OUTPUT BUILD_ID");
await mkdir(out, { recursive: true });
async function call(path: string, input: any) {
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
        throw Error(
          `Construction ${path} ${response.status}: ${text.slice(0, 2000)}`,
        );
      const result = JSON.parse(text);
      await appendFile(
        out + "/requests.jsonl",
        JSON.stringify({
          at: new Date().toISOString(),
          path,
          task: input.task,
          clientMs: performance.now() - started,
          ...result,
          output: undefined,
          work: {
            processed: result.output?.processed,
            tokens: result.output?.tokens,
            bytes: result.output?.emitted ?? result.output?.processed,
            dictionaryRequests: result.output?.dictionaryRequests,
            dictionaryBytes: result.output?.dictionaryBytes,
          },
        }) + "\n",
      );
      return result.output;
    } catch (e) {
      if (retry === 4) throw e;
      console.log("Retry", path, String(e));
      await new Promise((r) => setTimeout(r, 1000 * 2 ** retry));
    }
}
const health = (await fetch(url + "/health", {
  headers: { authorization: `Bearer ${token}` },
}).then((r) => r.json())) as any;
if (count > health.sourceDocuments)
  throw Error("Requested documents exceed available R2 corpus");
const sourceRoot = JSON.parse(
    await readFile("work/columnar-worker-build/source-root.json", "utf8"),
  ),
  sourceHash = createHash("sha256")
    .update(JSON.stringify({ sourceRoot, count }))
    .digest("hex");
const checkpoint = out + "/build.json",
  state = await readFile(checkpoint, "utf8").then(JSON.parse, () => ({
    build,
    code: health.code,
    sourceHash,
    count,
    startedAt: new Date().toISOString(),
    next: 0,
    runs: [],
    task: 0,
    level: 0,
    nextRuns: [],
    group: 0,
  }));
if (
  state.code !== health.code ||
  state.sourceHash !== sourceHash ||
  state.build !== build
)
  throw Error(
    "Build code or source changed; use another build directory and ID",
  );
async function save() {
  await writeFile(checkpoint + ".writing", JSON.stringify(state));
  await rename(checkpoint + ".writing", checkpoint);
}
while (state.next < count) {
  const run = (await call("/ingest", {
    task: `ingest-${state.next}`,
    first: state.next,
    count: Math.min(128, count - state.next),
  })) as Run;
  if (run.first !== state.next || run.next <= state.next || run.next > count)
    throw Error("Invalid ingestion continuation");
  state.runs.push(run);
  state.next = run.next;
  await save();
  console.log("R2 ingest", state.next, "/", count);
}
while (state.runs.length > 1) {
  while (state.group < state.runs.length) {
    const group: Run[] = state.runs.slice(state.group, state.group + 16);
    if (group.length === 1) {
      state.nextRuns.push(group[0]);
      state.group++;
      await save();
      continue;
    }
    const output = await call("/merge", {
      task: `merge-${state.level}-${state.group}-${state.task}`,
      runs: group,
      state: state.mergeState,
    });
    (state.mergeChunks ??= []).push(...output.chunks);
    state.mergeState = output.state;
    state.task++;
    if (output.state.done) {
      state.nextRuns.push({
        first: group[0].first,
        next: group.at(-1)!.next,
        count: group.reduce((n, r) => n + r.count, 0),
        bodyTokens: group.reduce((n, r) => n + r.bodyTokens, 0),
        titleTokens: group.reduce((n, r) => n + r.titleTokens, 0),
        chunks: state.mergeChunks,
      });
      state.group += group.length;
      state.mergeState = undefined;
      state.mergeChunks = undefined;
    }
    await save();
    console.log(
      "R2 merge",
      state.level,
      state.group,
      "/",
      state.runs.length,
      "task",
      state.task,
    );
  }
  state.runs = state.nextRuns;
  state.nextRuns = [];
  state.group = 0;
  state.level++;
  await save();
}
const run: Run = state.runs[0];
state.root ??= {
  format: "CWS1",
  generation: createHash("sha256")
    .update("CWS1:workers-v1:" + sourceHash)
    .digest("hex"),
  corpusHash: sourceHash,
  count,
  avgBody: run.bodyTokens / count,
  avgTitle: run.titleTokens / count,
  documents: Array.from(
    { length: Math.ceil(count / 4096) },
    () => [0, 0, 0] as Ref,
  ),
  dictionaries: [],
  hot: {},
  objects: [],
} satisfies Root;
const root: Root = state.root;
while (!state.postings?.done) {
  const task = `postings-${state.task}`;
  const output = await call("/postings", {
    task,
    run,
    statistics: { count, avgBody: root.avgBody, avgTitle: root.avgTitle },
    objectBase: root.objects.length,
    stateTask: state.postingsTask,
    ...(state.postingsTask ? {} : { state: state.postings }),
    compact: true,
  });
  root.objects.push(...output.objects);
  state.postings = output.state;
  state.postingsTask = task;
  state.task++;
  await save();
  console.log(
    "R2 postings",
    state.postings.nextTerm - 1,
    "terms",
    root.objects.length,
    "objects",
  );
}
root.dictionaries = state.postings.dictionaries.at(-1);
root.dictionaryHeight = state.postings.dictionaries.length - 1;
root.hot = Object.fromEntries(state.postings.hot);
state.rootRef ??= await call("/stage", {
  task: "dictionary-root",
  value: {
    ...root,
    idRouting: {
      dictionaries: state.postings.ids.dictionaries.at(-1),
      dictionaryHeight: state.postings.ids.dictionaries.length - 1,
    },
  },
});
while (!state.documentsDone) {
  const task = `documents-${state.task}`;
  const output = await call("/documents", {
    task,
    rootRef: state.rootRef,
    objectBase: root.objects.length,
    stateTask: state.documentsTask,
    ...(state.documentsTask ? {} : { state: state.documents }),
    compact: true,
  });
  root.objects.push(...output.objects);
  state.documents = output.state;
  state.documentsTask = task;
  state.documentsDone = output.done;
  state.task++;
  await save();
  console.log("R2 document frames", state.documents.next, "/", count);
}
root.documents = state.documents.documents;
// Layout can differ when a request yields at its time budget. Cache identity
// therefore includes the completed immutable layout, rather than source alone.
root.generation = await generationFor(root);
await writeFile(out + "/root.json", JSON.stringify(root));
await call("/publish", { task: "publish-" + root.generation, root });
await writeFile(
  out + "/manifest.json",
  JSON.stringify(
    {
      build,
      code: state.code,
      sourceHash,
      sourceDocuments: sourceRoot.documents,
      count,
      terms: state.postings.nextTerm - 1,
      bodyTokens: run.bodyTokens,
      titleTokens: run.titleTokens,
      generation: root.generation,
      objects: root.objects.length,
      bytes: root.objects.reduce((n, o) => n + o.size, 0),
      startedAt: state.startedAt,
      finishedAt: new Date().toISOString(),
      construction: "Cloudflare Workers and R2",
    },
    null,
    2,
  ),
);
console.log("Worker/R2 build complete", root.generation);
