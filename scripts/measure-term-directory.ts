import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { OfflineObjects } from "../src/columnar/offline.js";
import { benchmarkToken } from "../bench/columnar/token.js";
import {
  assembleTermDirectory,
  encodeDirectoryBlock,
  type DirectoryTerm,
  type DirectoryBlock,
} from "../src/columnar/term-directory.js";
import type { Root, Term } from "../src/columnar/format.js";
const dir = process.argv[2] ?? "work/columnar-100k-lanes",
  out = process.argv[3] ?? "work/term-directory-measurement";
await mkdir(out, { recursive: true });
const root: Root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  objects = new OfflineObjects(dir, root, {
    url: "https://work-search-cws-upload.phulin.workers.dev",
    token: await benchmarkToken(),
  });
const blocks: DirectoryBlock[] = [];
let pending: [string, DirectoryTerm][] = [],
  count = 0,
  rawBytes = 0;
const started = performance.now();
function flush() {
  if (!pending.length) return;
  const raw = encodeDirectoryBlock(pending);
  rawBytes += raw.length;
  blocks.push({
    first: pending[0][0],
    count: pending.length,
    data: gzipSync(raw),
  });
  pending = [];
}
async function visit(fences: Root["dictionaries"], height: number) {
  for (const f of fences) {
    const data = JSON.parse(
      new TextDecoder().decode(await objects.read(f.ref)),
    );
    if (height) await visit(data, height - 1);
    else
      for (const [name, t] of data as [string, Term][]) {
        pending.push([
          name,
          {
            ...t,
            bodyOccurrences: 0,
            titleOccurrences: 0,
            frequencies: t.tree.height ? [0, 0, 0] : t.tree.score,
            positional: t.tree.height ? [0, 0, 0] : t.tree.positions,
          },
        ]);
        count++;
        if (pending.length === 128) flush();
      }
    if (count && count % 32768 === 0) console.log("terms", count);
  }
}
try {
  await visit(root.dictionaries, root.dictionaryHeight ?? 0);
  flush();
  const data = assembleTermDirectory(blocks);
  await writeFile(out + "/directory.bin", data);
  const report = {
    kind: "Directory encoding size diagnostic only; occurrence counts are zero placeholders. Not a serving index.",
    generation: root.generation,
    count,
    blocks: blocks.length,
    rawBytes,
    bytes: data.length,
    ms: performance.now() - started,
  };
  await writeFile(out + "/size.json", JSON.stringify(report, null, 2));
  console.log(report);
} finally {
  await objects.close();
}
