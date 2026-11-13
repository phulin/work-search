import {
  readFile,
  writeFile,
  mkdir,
  rename,
  appendFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { benchmarkToken } from "../bench/columnar/token.js";
import { OfflineObjects } from "../src/columnar/offline.js";
import { packetDirectory } from "./packet-directory.js";
import { encodeDocumentDirectory } from "../src/columnar/document-directory.js";
import { constructionHTTP } from "./construction-http.js";
import {
  generationFor,
  VERIFY_OBJECTS,
} from "../src/columnar/construction/runs.js";
import { OBJECT_GROUP } from "../src/columnar/construction/finish.js";
import type { Root } from "../src/columnar/format.js";

const input = process.argv[2],
  out = process.argv[3],
  build = process.argv[4],
  width = Number(process.env.CWS_BUILD_CONCURRENCY ?? 32),
  url =
    process.env.CWS_BUILD_URL ??
    "https://work-search-cws-build-0.phulin.workers.dev",
  uploader = "https://work-search-cws-upload.phulin.workers.dev",
  token = await benchmarkToken();
if (
  !input ||
  !out ||
  !/^[a-z0-9-]{1,80}$/.test(build) ||
  !Number.isInteger(width) ||
  width < 1 ||
  width > 128
)
  throw Error(
    "Usage: build-packets-in-workers.ts SOURCE_BUILD OUTPUT BUILD_ID",
  );
await mkdir(out, { recursive: true });
const original: Root = JSON.parse(
    await readFile(
      input +
        (process.argv.includes("--scoring-root")
          ? "/scoring-root.json"
          : "/root.json"),
      "utf8",
    ),
  ),
  source = JSON.parse(await readFile(input + "/build.json", "utf8")),
  health = (await fetch(url + "/health", {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json())) as any,
  groupHealth = (await fetch(url + "/group-health", {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json())) as any,
  hash = (x: unknown) =>
    createHash("sha256").update(JSON.stringify(x)).digest("hex"),
  packageGeneration = hash({
    source: original.corpusHash,
    code: groupHealth.code,
    format: "grouped-CDP2",
  }),
  file = out + "/build.json",
  state = await readFile(file, "utf8").then(JSON.parse, () => ({
    code: health.code,
    groupCode: groupHealth.code,
    sourceGeneration: original.generation,
    build,
    startedAt: new Date().toISOString(),
    packageGeneration,
    terms: [],
    packages: [],
  }));
if (
  state.code !== health.code ||
  state.groupCode !== groupHealth.code ||
  state.sourceGeneration !== original.generation ||
  state.build !== build
)
  throw Error("Build code or source changed; use a new output and build name");
const reuseAt = process.argv.indexOf("--reuse-terms");
if (!state.terms.length && reuseAt >= 0) {
  const previous = JSON.parse(
    await readFile(process.argv[reuseAt + 1] + "/build.json", "utf8"),
  );
  if (
    previous.sourceGeneration !== original.generation ||
    !previous.terms.length ||
    previous.terms.some((j: any) => !j.done)
  )
    throw Error("Reused term packets must cover the same source generation");
  state.terms = previous.terms;
  state.rootRef = previous.rootRef;
  state.reusedTermsFrom = process.argv[reuseAt + 1];
}
let saving = Promise.resolve(),
  lastSaved = -Infinity;
function save(force = false) {
  if (!force && performance.now() - lastSaved < 1000) return saving;
  lastSaved = performance.now();
  saving = saving.then(async () => {
    await writeFile(file + ".writing", JSON.stringify(state));
    await rename(file + ".writing", file);
  });
  return saving;
}
let active = 0,
  window = Math.min(width, 16),
  successes = 0;
const post = constructionHTTP(width);
const waiting: (() => void)[] = [];
function wake() {
  while (active < window && waiting.length) {
    active++;
    waiting.shift()!();
  }
}
async function call(path: string, task: string, value: any = {}) {
  let busyRetries = 0,
    transientRetries = 0;
  for (let retry = 0; ; retry++) {
    if (active >= window) await new Promise<void>((r) => waiting.push(r));
    else active++;
    const started = performance.now();
    let released = false,
      busy = false;
    const release = () => {
      if (!released) {
        released = true;
        active--;
        wake();
      }
    };
    try {
      const r = await post(
          url + path,
          token,
          JSON.stringify({ build, task, ...value }),
        ),
        text = await r.text();
      if (!r.ok) {
        busy = r.status === 503 && text.includes("capacity busy");
        if (busy) {
          window = Math.max(2, Math.floor(window / 2));
          successes = 0;
        }
        throw Error(`${path} ${r.status}: ${text.slice(0, 1000)}`);
      }
      const result = JSON.parse(text);
      if (++successes >= 32) {
        window = Math.min(width, window + 1);
        successes = 0;
      }
      release();
      await appendFile(
        out + "/requests.jsonl",
        JSON.stringify({
          at: new Date().toISOString(),
          path,
          task,
          clientMs: performance.now() - started,
          concurrencyWindow: window,
          transport: "https-http1-keepalive",
          ...result,
          output: undefined,
        }) + "\n",
      );
      return result.output;
    } catch (e) {
      release();
      await appendFile(
        out + "/errors.jsonl",
        JSON.stringify({
          at: new Date().toISOString(),
          path,
          task,
          retry,
          error: String(e),
        }) + "\n",
      );
      if (busy ? ++busyRetries > 120 : ++transientRetries > 6) throw e;
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
async function pool<T>(jobs: T[], f: (job: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, jobs.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        await f(jobs[i], i);
      }
    }),
  );
}
if (!state.rootRef) {
  state.rootRef = await call("/stage", "source-root", { value: original });
  await save();
}
if (!state.terms.length) {
  const objects = new OfflineObjects(input, original, { url: uploader, token }),
    leaves: Root["dictionaries"] = [];
  async function visit(
    fences: Root["dictionaries"],
    height: number,
  ): Promise<void> {
    if (!height) {
      leaves.push(...fences);
      return;
    }
    for (let i = 0; i < fences.length; i += 8) {
      const data = await Promise.all(
        fences
          .slice(i, i + 8)
          .map(async (f) =>
            JSON.parse(new TextDecoder().decode(await objects.read(f.ref))),
          ),
      );
      for (const children of data) await visit(children, height - 1);
    }
  }
  try {
    await visit(original.dictionaries, original.dictionaryHeight ?? 0);
  } finally {
    await objects.close();
  }
  for (let i = 0; i < leaves.length; i += 4)
    state.terms.push({
      fences: leaves.slice(i, i + 4),
      objects: [],
      blocks: [],
      completedTerms: 0,
      bodyOccurrences: 0,
      titleOccurrences: 0,
      steps: 0,
    });
  await save();
}
if (!state.packages.length) {
  for (const vocabulary of source.vocabularies)
    for (const segment of vocabulary.segments)
      for (let first = segment.first; first < segment.end; first += 128)
        state.packages.push({
          ref: segment.ref,
          first,
          end: Math.min(segment.end, first + 128),
          next: first,
          tasks: [],
          bytes: 0,
        });
  await save();
}
// One deployment handles independently invocable bounded jobs. Bulk index data
// stays in R2; the coordinator receives only layout metadata and receipts.
await pool<any>(state.terms, async (job, i) => {
  while (!job.done) {
    const task = `terms-${i}-${job.steps}`,
      result = await call("/packet-terms", task, {
        rootRef: state.rootRef,
        fences: job.fences,
        objectBase: i * OBJECT_GROUP + job.objects.length,
        stateTask: job.previous,
        byteBudget: 32 * 1048576,
      });
    job.objects.push(...result.objects);
    job.blocks.push(...result.blocks);
    job.completedTerms += result.completedTerms;
    job.bodyOccurrences += result.bodyOccurrences;
    job.titleOccurrences += result.titleOccurrences;
    job.previous = task;
    job.steps++;
    job.done = !!result.state.done;
    await save();
  }
  console.log("Packet terms", i + 1, "/", state.terms.length);
});
const { directory, terms, bodyOccurrences, titleOccurrences } =
  await packetDirectory(state, out, uploader, token);
if (
  terms !== source.terms ||
  bodyOccurrences !== Math.round(original.count * original.avgBody) ||
  titleOccurrences !== Math.round(original.count * original.avgTitle)
)
  throw Error("Packet corpus coverage mismatch");
console.log(
  "Complete bundled directory",
  directory.length,
  "bytes",
  terms,
  "terms",
);
if (process.argv.includes("--directory-only")) process.exit(0);
await pool<any>(state.packages, async (job, i) => {
  while (job.next < job.end) {
    const task = `packages-${i}-${job.next}`,
      result = await call("/grouped-documents", task, {
        rootRef: source.rootRef,
        vocabularyRef: job.ref,
        generation: packageGeneration,
        first: job.next,
        count: job.end - job.next,
      });
    if (
      result.first !== job.next ||
      result.end <= job.next ||
      result.end > job.end
    )
      throw Error("Invalid package continuation");
    job.next = result.end;
    job.bytes += result.bytes;
    (job.groups ??= []).push(result.group);
    job.tasks.push(task);
    await save();
  }
  console.log("Document packages", i + 1, "/", state.packages.length);
});
const objects: Root["objects"] = [],
  objectIds: number[] = [],
  bytes = state.packages.reduce((n: number, j: any) => n + j.bytes, 0);
const groups = state.packages
    .flatMap((j: any) => j.groups)
    .map((g: any) => ({
      ...g,
      offsets: Uint8Array.from(Buffer.from(g.offsets, "base64")),
    }))
    .sort((a: any, b: any) => a.first - b.first),
  documentDirectory = encodeDocumentDirectory(groups, original.count);
await writeFile(out + "/documents.bin", documentDirectory);
state.terms.forEach((j: any, i: number) => {
  j.objects.forEach((o: any, n: number) => {
    objects.push(o);
    objectIds.push(i * OBJECT_GROUP + n);
  });
});
const root: Root = {
  ...original,
  generation: "",
  hot: {},
  dictionaries: [],
  dictionaryHeight: 0,
  documents: [],
  objects,
  objectIds,
  directory: {
    sha256: createHash("sha256").update(directory).digest("hex"),
    bytes: directory.length,
    terms,
  },
  documentPackages: {
    generation: packageGeneration,
    count: original.count,
    averageBytes: bytes / original.count,
    bytes,
    locators: {
      sha256: createHash("sha256").update(documentDirectory).digest("hex"),
      bytes: documentDirectory.length,
      groups: groups.length,
    },
  },
};
root.generation = await generationFor(root);
await writeFile(out + "/root.json", JSON.stringify(root));
const verifications: string[] = [];
for (let first = 0; first < root.objects.length; first += VERIFY_OBJECTS)
  verifications.push(`verify-${first}`);
await pool(verifications, async (task, i) => {
  await call("/verify", task, { root, first: i * VERIFY_OBJECTS });
});
const packageTasks = state.packages.flatMap((j: any) => j.tasks),
  coverage: string[] = [];
for (let i = 0; i < packageTasks.length; i += 256)
  coverage.push(`coverage-${i}`);
await pool(coverage, async (task, i) => {
  for (let retry = 0; ; retry++) {
    try {
      const r = await fetch(uploader + "/__verify-packages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          build,
          task,
          generation: packageGeneration,
          tasks: packageTasks.slice(i * 256, (i + 1) * 256),
        }),
        signal: AbortSignal.timeout(120000),
      });
      if (!r.ok)
        throw Error(
          "Package coverage " +
            r.status +
            ": " +
            (await r.text()).slice(0, 500),
        );
      return;
    } catch (error) {
      if (retry === 6) throw error;
      await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
    }
  }
});
await call("/publish", "publish", {
  root,
  verifications,
  packageVerifications: coverage,
});
state.finishedAt = new Date().toISOString();
await save(true);
const report = {
  format: "term-packets-and-document-packages",
  build,
  code: health.code,
  groupCode: groupHealth.code,
  sourceGeneration: original.generation,
  generation: root.generation,
  documents: root.count,
  terms,
  bodyOccurrences,
  titleOccurrences,
  directoryBytes: directory.length,
  packetBytes: objects.reduce((n, o) => n + o.size, 0),
  documentBytes: bytes,
  documentDirectoryBytes: documentDirectory.length,
  startedAt: state.startedAt,
  finishedAt: state.finishedAt,
  reused:
    "Existing native sorted postings and range vocabularies; newly constructed serving packets and document packages",
  workers: [url],
  concurrency: width,
};
await writeFile(out + "/manifest.json", JSON.stringify(report, null, 2));
console.log(report);
