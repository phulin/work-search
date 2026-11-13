import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";

const file = process.argv[2];
if (!file) throw Error("Usage: verify-corpus.ts CORPUS.jsonl.gz");
const manifest = JSON.parse(await readFile(file + ".manifest.json", "utf8")),
  expected = manifest.canonicalUncompressedSha256 ?? manifest.sha256,
  hash = createHash("sha256"),
  started = performance.now();
let documents = 0,
  bytes = 0,
  nextReport = 1073741824,
  last = -1;
for await (const chunk of createReadStream(file).pipe(createGunzip())) {
  const data = chunk as Buffer;
  hash.update(data);
  bytes += data.length;
  for (let at = data.indexOf(10); at !== -1; at = data.indexOf(10, at + 1))
    documents++;
  last = data[data.length - 1];
  if (bytes >= nextReport) {
    console.log("Verified source bytes", bytes, "documents", documents);
    nextReport += 1073741824;
  }
}
const sha256 = hash.digest("hex");
if (last !== 10 || documents !== manifest.documents || sha256 !== expected)
  throw Error("Local corpus count or canonical checksum mismatch");
const result = {
  file,
  documents,
  bytes,
  sha256,
  elapsedMs: performance.now() - started,
  verifiedAt: new Date().toISOString(),
};
await writeFile(file + ".verified.json", JSON.stringify(result, null, 2));
console.log(result);
