/** Reuse identical compressed passages and term objects; reconstruct only the
 * frozen CDP3 arrangement, so the format comparison does not change excerpts. */
import { readFile, writeFile, mkdir, link, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { DocumentDirectory } from "../../src/columnar/document-directory.js";
import { concat, view, pack, type Root } from "../../src/columnar/format.js";
const [candidate, output, original, oldStore, frozen] = process.argv.slice(2);
if (!frozen)
  throw Error(
    "Usage: build-verification-control.ts CANDIDATE OUTPUT ORIGINAL ORIGINAL_STORE FROZEN_CDP3_SOURCE",
  );
await mkdir(output, { recursive: true });
const oldDirectoryModule = await import(
    pathToFileURL(
      resolve("work/io-iteration/control/src/columnar/document-directory.ts"),
    ).href
  ),
  controlDirectoryModule = await import(
    pathToFileURL(resolve(frozen + "/src/columnar/document-directory.ts")).href
  ),
  oldDirectory = new oldDirectoryModule.DocumentDirectory(
    await readFile(original + "/documents.bin"),
  ),
  newDirectory = new DocumentDirectory(
    await readFile(candidate + "/documents.bin"),
  ),
  groups: any[] = [];
let oldKey = "",
  oldBytes: Uint8Array = new Uint8Array(),
  total = 0;
for (const group of newDirectory.groups()) {
  const data = await readFile(candidate + "/objects/" + group.key),
    parts: Uint8Array[] = [],
    offsets = [0];
  for (let doc = group.first; doc < group.end; doc++) {
    const loc = oldDirectory.lookup(doc);
    if (loc.key !== oldKey) {
      oldBytes = await readFile(oldStore + "/objects/" + loc.key);
      oldKey = loc.key;
    }
    const prior = oldBytes.subarray(loc.offset, loc.offset + loc.length),
      pv = view(prior),
      nl = newDirectory.lookup(doc),
      next = data.subarray(nl.offset, nl.offset + nl.length),
      nv = view(next),
      before = (i: number) =>
        prior.subarray(
          pv.getUint32(16 + i * 8, true),
          pv.getUint32(16 + i * 8, true) + pv.getUint32(20 + i * 8, true),
        ),
      sections = [
        before(0),
        before(1),
        before(2),
        before(3),
        next.subarray(
          nv.getUint32(40, true),
          nv.getUint32(40, true) + nv.getUint32(44, true),
        ),
        next.subarray(nv.getUint32(48, true)),
      ],
      head = new Uint8Array(64),
      v = view(head);
    [0x33504443, doc, nv.getUint32(8, true), nv.getUint32(12, true)].forEach(
      (n, i) => v.setUint32(i * 4, n, true),
    );
    let at = 64;
    sections.forEach((s, i) => {
      v.setUint32(16 + i * 8, at, true);
      v.setUint32(20 + i * 8, s.length, true);
      at += s.length;
    });
    const packet = concat([head, ...sections]);
    parts.push(packet);
    offsets.push(offsets.at(-1)! + packet.length);
  }
  const raw = concat(parts),
    sha256 = createHash("sha256").update(raw).digest("hex");
  await mkdir(candidate + "/objects/" + sha256, { recursive: true });
  await writeFile(candidate + "/objects/" + sha256 + "/plan-0.bin", raw);
  groups.push({ ...group, sha256, offsets: pack(offsets, true) });
  total += raw.length;
  if (group.end % 25000 < 128)
    console.log("Control documents", group.end, total);
}
const root: Root = JSON.parse(await readFile(candidate + "/root.json", "utf8")),
  directory = controlDirectoryModule.encodeDocumentDirectory(
    groups,
    root.count,
  );
await writeFile(output + "/documents.bin", directory);
await link(candidate + "/directory.bin", output + "/directory.bin");
root.documentPackages = {
  generation: createHash("sha256")
    .update("frozen-cdp3:" + root.documentPackages!.generation)
    .digest("hex"),
  count: root.count,
  bytes: total,
  averageBytes: total / root.count,
  locators: {
    sha256: createHash("sha256").update(directory).digest("hex"),
    bytes: directory.length,
    groups: groups.length,
  },
};
root.generation = createHash("sha256")
  .update(JSON.stringify({ ...root, generation: undefined }))
  .digest("hex");
await writeFile(output + "/root.json", JSON.stringify(root));
await mkdir(output + "/pairs", { recursive: true });
await symlink(
  resolve(candidate + "/objects"),
  output + "/pairs/objects",
  "dir",
);
const router = await readFile(candidate + "/router.bin"),
  v = view(router),
  n = v.getUint32(4, true),
  meta = JSON.parse(router.subarray(20, 20 + n).toString());
meta.baseGeneration = root.generation;
const json = Buffer.from(JSON.stringify(meta));
if (json.length !== n) throw Error("Router identity length mismatch");
router.set(json, 20);
await writeFile(output + "/pairs/router.bin", router);
const presence = JSON.parse(
  await readFile(candidate + "/presence.json", "utf8"),
);
presence.generation = meta.generation;
await writeFile(output + "/pairs/presence.json", JSON.stringify(presence));
await symlink(
  resolve(candidate + "/presence"),
  output + "/pairs/presence",
  "dir",
);
await writeFile(
  output + "/report.json",
  JSON.stringify(
    {
      generation: root.generation,
      bytes: total,
      documents: root.count,
      controlSource: frozen,
      excerptBytesIdentical: true,
    },
    null,
    2,
  ),
);
console.log("Complete control", root.generation, total);
