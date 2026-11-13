import { readFile, writeFile, mkdir, open } from "node:fs/promises";
import { demoWorkload } from "../demo-workload.js";
import { globalQueries } from "../global-workload.js";
import { ColumnarIndex } from "../../src/columnar/search.js";
import { Reader, Memory } from "../../src/columnar/storage.js";
import type { Root } from "../../src/columnar/format.js";
const dir = process.argv[2] ?? "work/columnar-100k",
  root: Root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  index = new ColumnarIndex(root),
  memory = new Memory();
const files = new Map<string, ReturnType<typeof open>>();
const source = {
  async read(key: string, offset: number, length: number) {
    const name = key.split("/").at(-1)!;
    let task = files.get(name);
    if (!task) files.set(name, (task = open(dir + "/packs/" + name, "r")));
    const b = Buffer.alloc(length);
    await (await task).read(b, 0, length, offset);
    return b;
  },
};
const oracle = JSON.parse(
  await readFile("work/global-bench/competitive-oracle.json", "utf8"),
);
const queries = [
    ...demoWorkload,
    ...globalQueries.filter((q) => !demoWorkload.some((p) => p.q === q.q)),
  ],
  rows: any[] = [];
for (const q of queries) {
  memory.clear();
  const start = performance.now(),
    cpu = process.cpuUsage();
  const r = await index.search(q.q, new Reader(root, source, memory));
  const usage = process.cpuUsage(cpu);
  const want = oracle[q.q];
  if (
    r.results.length !== want.length ||
    r.results.some(
      (h, i) =>
        h.id !== want[i].id ||
        Math.abs(h.score - want[i].score) >
          1e-11 * Math.max(1, Math.abs(want[i].score)),
    )
  )
    throw Error(
      "Mismatch " + q.q + " got " + r.results.map((r) => r.id).join(","),
    );
  const row = {
    ...q,
    ms: performance.now() - start,
    cpuMs: (usage.user + usage.system) / 1000,
    diagnostics: r.diagnostics,
  };
  rows.push(row);
  console.log(
    q.q,
    Math.round(row.ms),
    r.diagnostics.requests,
    r.diagnostics.positionIntegers,
  );
}
await mkdir("work/columnar-bench", { recursive: true });
await writeFile(
  `work/columnar-bench/${process.env.CWS_LABEL ?? "local"}.json`,
  JSON.stringify(
    {
      kind: "Local diagnostic, real disk, no latency model or shared cache; not Worker measurements",
      generation: root.generation,
      rows,
    },
    null,
    2,
  ),
);
for (const fd of files.values()) await (await fd).close();
