import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SourceRoot } from "../src/columnar/construction/source.js";
const input = process.argv[2] ?? "work/full-flp/published.json",
  out = process.argv[3] ?? "work/columnar-worker-build/source-root.json",
  published = JSON.parse(await readFile(input, "utf8")),
  root: SourceRoot = { format: "R2-source-v1", documents: 0, parts: [] };
for (const part of Object.values(published.shards).sort(
  (a: any, b: any) => a.id - b.id,
) as any[]) {
  if (
    !Number.isInteger(part.id) ||
    !Number.isInteger(part.documents) ||
    part.documents < 1 ||
    !/^[a-f0-9]{64}$/.test(part.generation) ||
    !/^[a-f0-9]{64}$/.test(part.inputSha256) ||
    root.parts.some((p) => p.part === part.id)
  )
    throw Error("Invalid published corpus partition");
  root.parts.push({
    part: part.id,
    generation: part.generation,
    first: root.documents,
    count: part.documents,
    inputSha256: part.inputSha256,
  });
  root.documents += part.documents;
}
if (!root.documents) throw Error("No published source documents");
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(root, null, 2) + "\n");
console.log(
  "Available R2 source",
  root.documents,
  "documents in",
  root.parts.length,
  "partitions",
);
