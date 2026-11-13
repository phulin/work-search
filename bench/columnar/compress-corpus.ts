import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { readFile, writeFile, rm } from "node:fs/promises";
const path = process.argv[2];
if (!path?.startsWith("work/columnar-corpus-"))
  throw Error("Expected task-owned columnar corpus path");
await pipeline(
  createReadStream(path),
  createGzip({ level: 1 }),
  createWriteStream(path + ".gz"),
);
const manifest = JSON.parse(await readFile(path + ".manifest.json", "utf8"));
await writeFile(
  path + ".gz.manifest.json",
  JSON.stringify(
    {
      ...manifest,
      compression: "gzip",
      canonicalUncompressedSha256: manifest.sha256,
    },
    null,
    2,
  ),
);
await rm(path);
console.log(
  "Compressed corpus; an active reader keeps its open file until ingestion finishes.",
);
