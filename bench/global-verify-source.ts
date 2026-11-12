import { readFile } from "node:fs/promises";
import { sourceVerifier } from "../src/global/source-identity.js";
import { jsonLines } from "../src/builder/jsonl.js";
const manifest = JSON.parse(
    await readFile("bench/generated/flp-100000/source/manifest.json", "utf8"),
  ),
  verify = sourceVerifier(manifest);
for await (const line of jsonLines("bench/generated/flp-100000/corpus.jsonl"))
  if (line.trim()) verify.add(JSON.parse(line));
verify.verify(manifest.generation);
console.log("Verified source corpus", manifest.documents, manifest.generation);
