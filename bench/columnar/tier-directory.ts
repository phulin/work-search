import { mkdir, readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tieredPacketDirectory } from "../../scripts/tiered-packet-directory.js";
import { generationFor } from "../../src/columnar/construction/runs.js";
import { constructionHTTP } from "../../scripts/construction-http.js";
import { benchmarkToken } from "./token.js";
import type { Root } from "../../src/columnar/format.js";

const [input, out, build, cap] = process.argv.slice(2),
  capacity = Number(cap ?? 1000000),
  width = Number(process.env.CWS_BUILD_CONCURRENCY ?? 16),
  url =
    process.env.CWS_BUILD_URL ??
    "https://work-search-cws-build-0.phulin.workers.dev/stem";
if (
  !out ||
  !/^[a-z0-9-]{1,80}$/.test(build ?? "") ||
  !Number.isInteger(width) ||
  width < 1 ||
  width > 64
)
  throw Error("Use PACKET_INDEX OUTPUT BUILD_ID [BUNDLED_TERMS]");
await mkdir(out, { recursive: true });
const token = await benchmarkToken(),
  headers = { authorization: `Bearer ${token}` },
  health = (await fetch(url + "/health", { headers }).then((r) =>
    r.json(),
  )) as any,
  root: Root = JSON.parse(await readFile(input + "/root.json", "utf8")),
  file = out + "/build.json",
  state = await readFile(file, "utf8").then(JSON.parse, async () => {
    const value = JSON.parse(await readFile(input + "/build.json", "utf8"));
    delete value.hotSelection;
    delete value.tieredTerms;
    return {
      ...value,
      build,
      tieringCode: health.code,
      inputGeneration: root.generation,
    };
  });
if (
  !health.code ||
  state.tieringCode !== health.code ||
  state.build !== build ||
  state.inputGeneration !== root.generation
)
  throw Error("Retiering source or constructor changed");
let saving = Promise.resolve();
const save = (_force?: boolean) =>
  (saving = saving.then(async () => {
    await writeFile(file + ".writing", JSON.stringify(state));
    await rename(file + ".writing", file);
  }));
const post = constructionHTTP(width);
const call = async (path: string, task: string, value: any) => {
  for (let retry = 0; ; retry++)
    try {
      const r = await post(
          url + path,
          token,
          JSON.stringify({ build, task, ...value }),
        ),
        text = await r.text();
      if (!r.ok) throw Error(`${path} ${r.status}: ${text.slice(0, 1000)}`);
      return JSON.parse(text).output;
    } catch (error) {
      if (retry >= 30) throw error;
      await new Promise((r) =>
        setTimeout(r, Math.min(5000, 500 + retry * 200)),
      );
    }
};
const started = performance.now(),
  tiered = await tieredPacketDirectory(
    state,
    root,
    out,
    "https://work-search-cws-upload.phulin.workers.dev",
    token,
    call,
    save,
    width,
    capacity,
  ),
  result: Root = {
    ...root,
    generation: "",
    objects: [...root.objects, ...tiered.objects],
    objectIds: [
      ...(root.objectIds ?? root.objects.map((_, i) => i)),
      ...tiered.objectIds,
    ],
    directory: {
      sha256: createHash("sha256").update(tiered.directory).digest("hex"),
      bytes: tiered.directory.length,
      terms: tiered.terms,
    },
  };
result.generation = await generationFor(result);
await writeFile(out + "/root.json", JSON.stringify(result));
if (root.documentPackages?.locators)
  await copyFile(input + "/documents.bin", out + "/documents.bin");
const report = {
  kind: "Native dictionary retiering benchmark",
  sourceGeneration: root.generation,
  generation: result.generation,
  analysis: root.analysis,
  code: health.code,
  documents: root.count,
  terms: tiered.terms,
  hotTerms: tiered.hotTerms,
  coldTerms: tiered.coldTerms,
  directoryBytes: tiered.directory.length,
  newShardBytes: tiered.objects.reduce((n, o) => n + o.size, 0),
  ms: performance.now() - started,
  note: "Frequency, positional and document packages are reused exactly from the immutable source. New shard objects were constructed natively. Deployment verifies their identities; this tool does not publish a production root.",
};
await writeFile(out + "/tiering.json", JSON.stringify(report, null, 2));
console.log(report);
