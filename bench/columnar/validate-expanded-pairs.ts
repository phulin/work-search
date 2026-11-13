import { readFile, writeFile } from "node:fs/promises";
import { deepStrictEqual } from "node:assert/strict";
import { benchmarkToken } from "./token.js";
import { constructionHTTP } from "../../scripts/construction-http.js";
import { OfflineObjects } from "../../src/columnar/offline.js";
import { PairDirectory } from "../../src/columnar/pair-directory.js";
import type { Root, PositionalPair } from "../../src/columnar/format.js";
const [base, previous, output] = process.argv.slice(2);
if (!output) throw Error("Use PACKET_BUILD PREVIOUS_PAIR_BUILD OUTPUT.json");
const state = JSON.parse(await readFile(previous + "/build.json", "utf8")),
  packages = JSON.parse(await readFile(base + "/build.json", "utf8")),
  root: Root = JSON.parse(await readFile(previous + "/root.json", "utf8")),
  token = await benchmarkToken(),
  post = constructionHTTP(1),
  url = "https://work-search-cws-build-0.phulin.workers.dev";
async function call(path: string, task: string, input: unknown) {
  for (let retry = 0; retry < 60; retry++) {
    const r = await post(
      url + path,
      token,
      JSON.stringify({
        build: "expanded-pair-validation-v1",
        task,
        ...(input as object),
      }),
    );
    const text = await r.text();
    if (r.status === 503) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (!r.ok) throw Error(text);
    return JSON.parse(text).output;
  }
  throw Error("Native validation capacity retries exhausted");
}
const occurrences = await call(
  "/expanded-pair-occurrences",
  "old-selection-group0",
  {
    selectionRef: state.selectionRef,
    group: packages.packages[0].groups[0],
  },
);
const hashes = (runs: any[]) =>
  runs.flatMap((r) => r.chunks.map((c: any) => [c.sha256, c.size]));
deepStrictEqual(hashes(occurrences.runs), hashes(state.occurrences[0]));
const pairs = Object.values(root.positionalPairs!)
    .sort((a, b) => a.a - b.a || a.b - b.b)
    .slice(0, 64),
  ids = [
    ...new Set(pairs.filter((p) => p.ref[2] <= 16384).map((p) => p.ref[0])),
  ].sort((a, b) => a - b),
  objectBase = 500000000,
  directory = await call("/expanded-pair-directory", "directory64", {
    pairs,
    objectIds: ids,
    objects: ids.map((id) => root.objects[root.objectIds!.indexOf(id)]),
    objectBase,
  }),
  remote = { url: "https://work-search-cws-upload.phulin.workers.dev", token },
  original = new OfflineObjects(previous, root, remote),
  built = new OfflineObjects(
    previous,
    {
      generation: root.generation,
      objects: directory.objects,
      objectIds: directory.objects.map(
        (_: unknown, i: number) => objectBase + i,
      ),
    },
    remote,
  );
let checked = 0,
  inlineBytes = 0;
try {
  for (const shard of directory.shards) {
    const d = new PairDirectory(await built.read(shard.ref), shard.ref);
    for (const expected of pairs) {
      const actual = d.lookup(expected.a, expected.b);
      if (!actual) continue;
      const { ref: _actualRef, ...a } = actual,
        { ref: _expectedRef, ...e } = expected;
      deepStrictEqual(a, e);
      if (actual.ref[0] >= objectBase) {
        const raw = await built.read(actual.ref);
        deepStrictEqual(raw, await original.read(expected.ref));
        inlineBytes += raw.length;
      } else deepStrictEqual(actual.ref, expected.ref);
      checked++;
    }
  }
} finally {
  await original.close();
  await built.close();
}
if (
  checked !== pairs.length ||
  checked !== directory.pairs ||
  inlineBytes !== directory.inlineBytes
)
  throw Error("Incomplete native directory validation");
const health = await fetch(url + "/expanded-pair-health", {
  headers: { authorization: `Bearer ${token}` },
}).then((r) => r.json());
const result = {
  checkedAt: new Date().toISOString(),
  health,
  sourceGeneration: root.generation,
  occurrenceChunkHashes: hashes(occurrences.runs),
  pairs: checked,
  inlineBytes,
  shards: directory.shards.length,
  objects: directory.objects,
  note: "Live native occurrence hashes match prior output; every directory descriptor and inlined complete packet matches the immutable source.",
};
await writeFile(output, JSON.stringify(result, null, 2));
console.log(result.note, { pairs: checked, inlineBytes });
