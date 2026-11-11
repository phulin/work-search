import { readFile, writeFile } from "node:fs/promises";
import { BinaryIndex } from "../src/format/index.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { loadPosting } from "../src/query/load.js";
import { loadPosting as before } from "./baseline-v5-blocks/load.js";
const root = "bench/generated/1000000-48-workload",
  index = new BinaryIndex(await readFile(root + "/bundle.bin")),
  store = new FileStorage(root + "/objects");
const samples = [];
for (const term of ["document", "search", "word0"])
  for (const positions of [false, true]) {
    const e = index.lookup(term)!;
    const f =
      e.object === 0xffffffff
        ? index.bytes.subarray(
            index.local + e.offset,
            index.local + e.offset + e.length,
          )
        : await store.read(index.key(e.object), e.offset, e.length);
    const p = positions
      ? e.positionObject === 0xffffffff
        ? index.bytes.subarray(
            index.local + e.positionOffset,
            index.local + e.positionOffset + e.positionLength,
          )
        : await store.read(
            index.key(e.positionObject, "positions"),
            e.positionOffset,
            e.positionLength,
          )
      : undefined;
    const read = async (
      _: unknown,
      pos: boolean,
      offset: number,
      length: number,
    ) => (pos ? p! : f).subarray(offset, offset + length);
    await before(e, positions, read);
    await loadPosting(e, positions, read);
    for (let pass = 0; pass < 5; pass++) {
      async function run(fn: typeof loadPosting) {
        const start = performance.now();
        const result = await fn(e, positions, read);
        return { ms: performance.now() - start, count: result.docs.length };
      }
      const [x, y] =
        pass % 2
          ? [await run(loadPosting), await run(before)]
          : [await run(before), await run(loadPosting)];
      samples.push({
        term,
        positions,
        before: pass % 2 ? y : x,
        after: pass % 2 ? x : y,
      });
    }
  }
await writeFile(
  "bench/results/block-decoder-profile.json",
  JSON.stringify(
    {
      kind: "preloaded bytes, decoder only, alternating order, local Node; five measured passes after warmup",
      samples,
    },
    null,
    2,
  ),
);
