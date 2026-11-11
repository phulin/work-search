import { readFile, writeFile } from "node:fs/promises";
import { DocumentTable, encodeDocuments } from "../src/format/documents.js";
import { DocumentTable as Baseline } from "./baseline-v2/documents.js";
import { BinaryIndex } from "../src/format/index.js";
const index = new BinaryIndex(
  await readFile("bench/generated/1000000-8-smallest/bundle.bin"),
);
const constant = index.bytes.subarray(index.docs, index.local);
const count = 1000000;
const varying = encodeDocuments(
  Array.from({ length: count }, (_, i) => ({
    id: `doc-${i}`,
    body: (i * 73) % 1024,
    title: i % 9,
    metaObject: 0,
    metaOffset: i * 80,
    metaLength: 80,
  })),
);
const rows = [];
for (const [name, bytes] of [
  ["constant", constant],
  ["varying", varying],
] as const) {
  const old = new Baseline(bytes, count),
    current = new DocumentTable(bytes, count);
  for (const access of ["sequential", "strided"] as const) {
    const samples: {
      baselineMs: number;
      optimizedMs: number;
      checksum: number;
    }[] = [];
    function run(table: Baseline | DocumentTable) {
      let sum = 0;
      const start = performance.now();
      for (let i = 0; i < count; i++) {
        const d = table.lengths(
          access === "sequential" ? i : (i * 65537) % count,
        );
        sum += d.body + d.title;
      }
      return { ms: performance.now() - start, sum };
    }
    run(old);
    run(current); // Warm validation bits and JIT; cold checks measured in query matrix.
    for (let pass = 0; pass < 12; pass++) {
      const [a, b] =
        pass % 2 ? [run(current), run(old)] : [run(old), run(current)];
      const before = pass % 2 ? b : a,
        after = pass % 2 ? a : b;
      if (before.sum !== after.sum) throw new Error("Length checksum mismatch");
      samples.push({
        baselineMs: before.ms,
        optimizedMs: after.ms,
        checksum: after.sum,
      });
    }
    const median = (key: "baselineMs" | "optimizedMs") =>
      samples.map((s) => s[key]).sort((a, b) => a - b)[
        Math.floor(samples.length / 2)
      ];
    rows.push({
      name,
      access,
      documents: count,
      baselineMedianMs: median("baselineMs"),
      optimizedMedianMs: median("optimizedMs"),
      samples,
    });
  }
}
await writeFile(
  "bench/results/length-access.json",
  JSON.stringify(
    {
      kind: "same-process paired alternating-order microbenchmark; frozen 6799e3d reader vs optimized reader; warm block validation",
      rows,
    },
    null,
    2,
  ),
);
console.log(rows.map(({ samples, ...r }) => r));
