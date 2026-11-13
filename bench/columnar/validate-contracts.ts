import { readFile } from "node:fs/promises";
import { ColumnarIndex } from "../../src/columnar/search.js";
import { Reader, Memory } from "../../src/columnar/storage.js";
import { Heads } from "../../src/columnar/heads.js";
import { OfflineObjects } from "../../src/columnar/offline.js";
const dir = process.argv[2] ?? "work/columnar-100k-lanes",
  root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  heads = new Heads(
    JSON.parse(await readFile(dir + "/heads-root.json", "utf8")),
    await readFile(dir + "/heads.bin"),
    root,
  ),
  index = new ColumnarIndex(root, heads),
  objects = new OfflineObjects(dir, root),
  memory = new Memory(),
  source = {
    async read(key: string, o: number, n: number) {
      return objects.read([Number(key.match(/plan-(\d+)/)![1]), o, n]);
    },
  };
try {
  for (const c of JSON.parse(
    await readFile("work/columnar-bench/contracts.json", "utf8"),
  )) {
    const got = await index.search(
      c.q,
      new Reader(root, source, memory),
      c.options,
    );
    if (
      got.results.length !== c.oracle.length ||
      got.results.some(
        (h, i) =>
          h.id !== c.oracle[i].id ||
          Math.abs(h.score - c.oracle[i].score) >
            1e-11 * Math.max(1, Math.abs(c.oracle[i].score)),
      )
    )
      throw Error("Contract mismatch " + JSON.stringify(c.options) + " " + c.q);
    console.log("Contract passed", c.kind, c.q, got.results.length);
  }
} finally {
  await objects.close();
}
