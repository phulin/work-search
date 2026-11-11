import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/builder/build.js";
import { repack } from "./repack.js";
import { BinaryIndex } from "../src/format/index.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
const root = await mkdtemp(join(tmpdir(), "dense-bench-"));
try {
  const input = join(root, "input"),
    source = join(root, "source");
  const n = 32768,
    queries = ['"alpha beta"', "alpha /2 beta", "alpha /1 gamma"];
  await writeFile(
    input,
    Array.from({ length: n }, (_, i) =>
      JSON.stringify({ id: `d${i}`, body: "alpha beta gamma ".repeat(64) }),
    ).join("\n"),
  );
  await build({ input, out: source, budget: 8388608 });
  const fixtures = [];
  for (const stage of [4, 5]) {
    const out = join(root, String(stage));
    await repack(source, out, 8388608, "frequency", queries, stage);
    fixtures.push({
      stage,
      index: new BinaryIndex(await readFile(out + "/bundle.bin")),
      store: new FileStorage(out + "/objects"),
    });
  }
  const samples: any[] = [];
  for (let pass = 0; pass < 5; pass++)
    for (const q of queries) {
      let expected: string | undefined;
      for (const fixture of pass % 2 ? [...fixtures].reverse() : fixtures) {
        const t = performance.now(),
          r = await search(fixture.index, fixture.store, q, {
            optimizationStage: 5,
          });
        const ms = performance.now() - t,
          s = JSON.stringify(r.results);
        if (expected && expected !== s) throw Error("Dense result mismatch");
        expected = s;
        samples.push({ stage: fixture.stage, q, pass, ms, ...r.diagnostics });
      }
    }
  await writeFile(
    "bench/results/next-dense.json",
    JSON.stringify(
      {
        local: true,
        documents: n,
        repetitions: 64,
        positionsPerDocument: 192,
        samples,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      samples.map((s) => ({ stage: s.stage, pass: s.pass, q: s.q, ms: s.ms })),
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
