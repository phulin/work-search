import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { jsonLines } from "../builder/jsonl.js";
import { crc32 } from "../format/codec.js";
export async function packOpinions(
  input: string,
  out: string,
  count: number,
  idAt: (i: number) => string,
) {
  await mkdir(out, { recursive: true });
  const objects: { name: string; size: number; sha256: string }[] = [],
    catalog = new Uint8Array(count * 32),
    v = new DataView(catalog.buffer);
  let row = 0;
  const writer = async (kind: string) => {
    let object = 0,
      offset = 0,
      file = await open(`${out}/${kind}-0.bin`, "w");
    const names = [`${kind}-0.bin`];
    return {
      async put(bytes: Uint8Array) {
        if (offset && offset + bytes.length > 64 * 1048576) {
          await file.close();
          object++;
          offset = 0;
          const name = `${kind}-${object}.bin`;
          names.push(name);
          file = await open(out + "/" + name, "w");
        }
        const pointer = [object, offset, bytes.length, crc32(bytes)];
        await file.writeFile(bytes);
        offset += bytes.length;
        return pointer;
      },
      async close() {
        await file.close();
        return names;
      },
    };
  };
  const body = await writer("content"),
    info = await writer("info");
  for await (const line of jsonLines(input)) {
    if (!line.trim()) continue;
    const d = JSON.parse(line);
    if (row >= count || d.id !== idAt(row))
      throw Error("Opinion text/document identity mismatch");
    const b = await body.put(gzipSync(Buffer.from(d.body), { level: 1 })),
      m = await info.put(
        Buffer.from(
          JSON.stringify({ id: d.id, title: d.title, metadata: d.metadata }),
        ),
      );
    [...b, ...m].forEach((n, i) => v.setUint32(row * 32 + i * 4, n, true));
    row++;
  }
  if (row !== count) throw Error("Opinion text count mismatch");
  const names = [
    ...(await body.close()),
    ...(await info.close()),
    "contentmap-0.bin",
  ];
  await writeFile(out + "/contentmap-0.bin", catalog);
  for (const name of names) {
    const hash = createHash("sha256");
    let size = 0;
    for await (const b of createReadStream(out + "/" + name)) {
      hash.update(b);
      size += b.length;
    }
    objects.push({ name, size, sha256: hash.digest("hex") });
  }
  const manifest = {
    documents: count,
    recordBytes: 32,
    encoding: "gzip",
    objects,
  };
  await writeFile(
    out + "/viewer-manifest.json",
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}
