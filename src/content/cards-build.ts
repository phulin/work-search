import { mkdir, writeFile, open, readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { crc32 } from "../format/codec.js";
import type { ResultCard } from "./cards.js";
export async function packCards(
  out: string,
  generation: string,
  count: number,
  records: AsyncIterable<ResultCard>,
  caseGeneration: string,
) {
  await mkdir(out, { recursive: true });
  const dirs = new Uint8Array(Math.ceil(count / 128) * 16),
    view = new DataView(dirs.buffer),
    names = ["cards-0.bin"];
  let obj = 0,
    offset = 0,
    block = 0,
    seen = 0,
    pending: ResultCard[] = [],
    file = await open(out + "/cards-0.bin", "w");
  const flush = async () => {
    if (!pending.length) return;
    const raw = Buffer.from(JSON.stringify(pending));
    if (raw.length > 4 * 1048576) throw Error("Card expansion limit");
    const bytes = gzipSync(raw, { level: 1 });
    if (offset && offset + bytes.length > 64 * 1048576) {
      await file.close();
      obj++;
      offset = 0;
      names.push(`cards-${obj}.bin`);
      file = await open(out + `/cards-${obj}.bin`, "w");
    }
    [obj, offset, bytes.length, crc32(bytes)].forEach((n, i) =>
      view.setUint32(block * 16 + i * 4, n, true),
    );
    await file.writeFile(bytes);
    offset += bytes.length;
    block++;
    pending = [];
  };
  try {
    for await (const card of records) {
      if (card.doc !== seen || seen >= count)
        throw Error("Card input ordering mismatch");
      pending.push(card);
      seen++;
      if (pending.length === 128) await flush();
    }
    await flush();
  } finally {
    await file.close();
  }
  if (seen !== count) throw Error("Card input count mismatch");
  const objects = [];
  for (const name of names) {
    const b = await readFile(out + "/" + name);
    objects.push({
      name,
      size: b.length,
      sha256: createHash("sha256").update(b).digest("hex"),
    });
  }
  const cardGeneration = createHash("sha256")
      .update(JSON.stringify({ generation, caseGeneration, objects }))
      .digest("hex"),
    root = new Uint8Array(80 + dirs.length),
    v = new DataView(root.buffer);
  v.setUint32(0, 0x31445243, true);
  v.setUint32(4, count, true);
  v.setUint32(8, 128, true);
  v.setUint32(12, crc32(dirs), true);
  root.set(Buffer.from(generation, "hex"), 16);
  root.set(Buffer.from(cardGeneration, "hex"), 48);
  root.set(dirs, 80);
  await writeFile(out + "/cardroot-0.bin", root);
  const manifest = {
    version: 1,
    indexGeneration: generation,
    cardGeneration,
    caseGeneration,
    count,
    objects,
    root: {
      name: "cardroot-0.bin",
      size: root.length,
      sha256: createHash("sha256").update(root).digest("hex"),
    },
  };
  await writeFile(out + "/manifest.json", JSON.stringify(manifest, null, 2));
  return manifest;
}
