/** Change first-read policy without rewriting immutable document payloads. */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  DocumentDirectory,
  encodeDocumentDirectory,
} from "../../src/columnar/document-directory.js";
import { pack, view } from "../../src/columnar/format.js";
import { VERIFICATION_PREFIX_BYTES } from "../../src/columnar/document-package.js";
const [index, limitText] = process.argv.slice(2),
  limit = Number(limitText ?? VERIFICATION_PREFIX_BYTES);
if (!index || !Number.isInteger(limit) || limit < 16384 || limit > 1048576)
  throw Error("Usage: set-verification-prefix.ts INDEX [COMPLETE_BYTES]");
const root = JSON.parse(await readFile(index + "/root.json", "utf8")),
  directory = new DocumentDirectory(await readFile(index + "/documents.bin")),
  groups = [];
let complete = 0;
for (const group of directory.groups()) {
  const raw = await readFile(index + "/objects/" + group.key),
    offsets = [0],
    prefixes = [],
    budgets = [];
  for (let doc = group.first; doc < group.end; doc++) {
    const loc = directory.lookup(doc),
      v = view(raw.subarray(loc.offset, loc.offset + 64)),
      n = loc.verificationBytes;
    const prefix = n <= limit ? n : v.getUint32(20, true);
    complete += Number(prefix === n);
    prefixes.push(prefix);
    budgets.push(n);
    offsets.push(loc.offset + loc.length);
  }
  groups.push({
    first: group.first,
    end: group.end,
    sha256: group.key.split("/")[0],
    offsets: pack(offsets, true),
    prefixes: pack(prefixes),
    verificationBytes: pack(budgets),
  });
}
const bytes = encodeDocumentDirectory(groups, root.count);
await writeFile(index + "/documents.bin", bytes);
root.documentPackages.locators.bytes = bytes.length;
root.documentPackages.locators.sha256 = createHash("sha256")
  .update(bytes)
  .digest("hex");
root.generation = createHash("sha256")
  .update(JSON.stringify({ ...root, generation: undefined }))
  .digest("hex");
await writeFile(index + "/root.json", JSON.stringify(root));
const router = await readFile(index + "/router.bin"),
  v = view(router),
  n = v.getUint32(4, true),
  metadata = JSON.parse(router.subarray(20, 20 + n).toString());
metadata.baseGeneration = root.generation;
const json = Buffer.from(JSON.stringify(metadata));
if (json.length !== n) throw Error("Router metadata extent changed");
router.set(json, 20);
await writeFile(index + "/router.bin", router);
await writeFile(
  index + "/prefix-report.json",
  JSON.stringify(
    {
      generation: root.generation,
      completeBytes: limit,
      complete,
      count: root.count,
    },
    null,
    2,
  ),
);
console.log(
  "Complete numeric first reads",
  complete,
  "of",
  root.count,
  "threshold",
  limit,
);
