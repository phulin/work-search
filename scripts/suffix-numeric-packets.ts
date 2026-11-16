import {
  open,
  readFile,
  writeFile,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  baseColumns,
  encodeNumericBase,
  NumericDirectoryBuilder,
} from "../src/suffix/numeric-packets.js";
import type { SuffixBlock, SuffixManifest } from "../src/suffix/format.js";

const [directory, manifestName = "manifest-fences.json"] =
  process.argv.slice(2);
if (!directory) throw Error("Use SUFFIX_DIRECTORY [MANIFEST]");
const manifest: SuffixManifest = JSON.parse(
    await readFile(directory + "/" + manifestName, "utf8"),
  ),
  started = Date.now(),
  metadata = await open(directory + "/directory", "r"),
  sources = await Promise.all(
    baseColumns.map((c) => open(directory + "/" + c, "r")),
  ),
  temporary = directory + "/numeric-base.partial",
  output = await open(temporary, "wx"),
  digest = createHash("sha256");
async function read(handle: FileHandle, offset: number, length: number) {
  const raw = Buffer.allocUnsafe(length);
  let at = 0;
  while (at < length) {
    const { bytesRead } = await handle.read(raw, at, length - at, offset + at);
    if (!bytesRead) throw Error("Truncated local suffix input");
    at += bytesRead;
  }
  return raw;
}
async function blocks(
  group: SuffixManifest["directory"][number],
): Promise<SuffixBlock[]> {
  return JSON.parse(
    gunzipSync(
      await read(metadata, group.ref.offset, group.ref.length),
    ).toString(),
  );
}
let count = 0,
  bytes = 0,
  rawIndex: Uint8Array;
try {
  for (const group of manifest.directory) count += (await blocks(group)).length;
  const builder = new NumericDirectoryBuilder(
    count,
    manifest.corpusGeneration,
    manifest.rows,
  );
  for (const [groupIndex, group] of manifest.directory.entries()) {
    const selected = await blocks(group);
    // Local reads are contiguous per column and group. Only these buffers and
    // one group of output packets are live, independent of corpus size.
    const extents = await Promise.all(
      baseColumns.map(async (name, i) => {
        const first = selected[0].columns[name],
          last = selected.at(-1)!.columns[name];
        return read(
          sources[i],
          first.offset,
          last.offset + last.length - first.offset,
        );
      }),
    );
    const packets = selected.map((block) => {
      const packet = encodeNumericBase(
        block,
        baseColumns.map((name, i) => {
          const start =
            block.columns[name].offset - selected[0].columns[name].offset;
          return extents[i].subarray(start, start + block.columns[name].length);
        }),
      );
      builder.append(block, packet.length);
      digest.update(packet);
      bytes += packet.length;
      return packet;
    });
    let pending = packets;
    while (pending.length) {
      let used = (await output.writev(pending)).bytesWritten;
      if (!used) throw Error("Cannot write numeric packets");
      let at = 0;
      while (at < pending.length && used >= pending[at].length)
        used -= pending[at++].length;
      pending = pending.slice(at);
      if (used) pending[0] = pending[0].subarray(used);
    }
    if (groupIndex % 100 === 0)
      console.log(
        JSON.stringify({
          groups: groupIndex + 1,
          totalGroups: manifest.directory.length,
          bytes,
          seconds: (Date.now() - started) / 1000,
        }),
      );
  }
  rawIndex = builder.finish();
} catch (error) {
  await rm(temporary, { force: true });
  throw error;
} finally {
  await Promise.all([
    metadata.close(),
    output.close(),
    ...sources.map((s) => s.close()),
  ]);
}
const sha256 = digest.digest("hex"),
  data = "numeric-base-" + sha256.slice(0, 16),
  indexHash = createHash("sha256").update(rawIndex).digest("hex"),
  index = "numeric-index-" + indexHash.slice(0, 16);
await rename(temporary, directory + "/" + data);
await writeFile(directory + "/" + index, rawIndex);
manifest.files[data] = { bytes, sha256 };
manifest.files[index] = { bytes: rawIndex.length, sha256: indexHash };
manifest.numericPackets = { index, data };
manifest.generation = "";
manifest.generation = createHash("sha256")
  .update(JSON.stringify(manifest))
  .digest("hex");
await writeFile(directory + "/manifest-numeric.json", JSON.stringify(manifest));
console.log(
  JSON.stringify({
    generation: manifest.generation,
    blocks: count,
    bytes,
    indexBytes: rawIndex.length,
    seconds: (Date.now() - started) / 1000,
  }),
);
