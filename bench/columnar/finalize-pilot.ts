// Complete the locator root for the first in-flight builder pilot. Subsequent
// builds produce it directly. This is benchmark artifact migration, not serving
// compatibility with any obsolete format.
import { readFile, writeFile, open } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { crc32 } from "../../src/format/codec.js";
import { Packer } from "../../src/columnar/packer.js";
import {
  PAGE,
  concat,
  refAt,
  view,
  type Root,
  type Ref,
  u32,
} from "../../src/columnar/format.js";
const dir = process.argv[2] ?? "work/columnar-100k",
  root: Root = JSON.parse(await readFile(dir + "/root.json", "utf8"));
const db = new DatabaseSync(dir + "/sort.sqlite", { readOnly: true }),
  packer = new Packer(dir + "/packs", {
    next: root.objects.length,
    objects: [...root.objects],
  });
const files = new Map<number, Awaited<ReturnType<typeof open>>>();
async function read(ref: Ref) {
  let fd = files.get(ref[0]);
  if (!fd)
    files.set(
      ref[0],
      (fd = await open(`${dir}/packs/plan-${ref[0]}.bin`, "r")),
    );
  const b = Buffer.alloc(ref[2]);
  await fd.read(b, 0, b.length, ref[1]);
  return b;
}
root.documents = [];
let batch: Uint8Array[] = [];
for (const d of db
  .prepare("SELECT * FROM docs ORDER BY doc")
  .iterate() as Iterable<any>) {
  const f = refAt(view(d.forward), 0),
    head = refAt(view(await read(f)), 20);
  batch.push(concat([d.record, d.forward, u32(head)]));
  if (batch.length === 4096) {
    root.documents.push(packer.put(concat(batch)));
    batch = [];
  }
}
if (batch.length) root.documents.push(packer.put(concat(batch)));
packer.flush();
for (const o of root.objects) {
  const b = await readFile(dir + "/packs/" + o.name);
  o.checksums = [];
  for (let p = 0; p < b.length; p += PAGE)
    o.checksums.push(crc32(b.subarray(p, p + PAGE)));
}
root.objects = packer.objects;
await writeFile(dir + "/root.json", JSON.stringify(root));
for (const f of files.values()) await f.close();
db.close();
