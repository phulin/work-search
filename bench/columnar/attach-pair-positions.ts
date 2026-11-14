import { readFile, writeFile, mkdir, copyFile, link } from "node:fs/promises";
import {
  PairRouter,
  encodePairRouter,
  pairObjectKey,
  type PairLeaf,
} from "../../src/columnar/pair-router.js";
import {
  PairMembershipPacket,
  PairMembership,
  encodePairMembership,
  encodePairMembershipPacket,
} from "../../src/columnar/pair-membership.js";
import { PacketObjects } from "../../src/columnar/packet-objects.js";
import { view } from "../../src/columnar/format.js";
const [index, pairs, original] = process.argv.slice(2);
if (!original)
  throw Error(
    "Usage: attach-pair-positions.ts INDEX CONVERTED_PAIRS ORIGINAL_PAIRS",
  );
const root = JSON.parse(await readFile(index + "/root.json", "utf8")),
  raw = await readFile(pairs + "/router.bin"),
  router = new PairRouter(raw),
  v = view(raw),
  report = JSON.parse(await readFile(pairs + "/positions-report.json", "utf8"));
if (report.generation !== router.metadata.generation)
  throw Error("Positional/membership generation mismatch");
const json = v.getUint32(4, true),
  n = v.getUint32(8, true),
  count = v.getUint32(12, true),
  base = 20 + json,
  table = base + n * 8,
  nodes: [number, number][] = Array.from({ length: n }, (_, i) => [
    v.getInt32(base + i * 8, true),
    v.getInt32(base + i * 8 + 4, true),
  ]),
  leaves: PairLeaf[] = Array.from({ length: count }, (_, i) => ({
    object: v.getUint32(table + i * 16, true),
    offset: v.getUint32(table + i * 16 + 4, true),
    bytes: v.getUint32(table + i * 16 + 8, true),
    pairs: v.getUint32(table + i * 16 + 12, true),
    namespace: 0,
    bits: 0,
    prefix: 0,
    crc32: 0,
  })),
  patches = new Map<string, Map<string, Uint8Array>>();
for (const p of report.catalog) {
  const leaf = router.route(p.a, p.b)!,
    key = pairObjectKey(router.metadata.generation, leaf);
  if (!patches.has(key)) patches.set(key, new Map());
  patches
    .get(key)!
    .set(p.a + "\0" + p.b, await readFile(pairs + "/" + p.directory));
}
const store = new PacketObjects(
  async (id, bytes) => writeFile(pairs + `/objects/pairs-${id}.bin`, bytes),
  leaves.reduce((n, l) => Math.max(n, l.object), -1) + 1,
);
let patched = 0;
for (const leaf of leaves) {
  const changes = patches.get(pairObjectKey(router.metadata.generation, leaf));
  if (!changes) continue;
  const file = await readFile(pairs + `/objects/pairs-${leaf.object}.bin`),
    packet = file.subarray(leaf.offset, leaf.offset + leaf.bytes),
    d = view(packet),
    entries = [];
  for (let i = 0; i < d.getUint32(4, true); i++) {
    const p = 16 + i * 16,
      key = new TextDecoder().decode(
        packet.subarray(
          d.getUint32(p, true),
          d.getUint32(p, true) + d.getUint32(p + 4, true),
        ),
      ),
      [a, b] = key.split("\0"),
      at = d.getUint32(p + 8, true),
      len = d.getUint32(p + 12, true);
    let data: Uint8Array = packet.subarray(at, at + len);
    if (changes.has(key)) {
      const r = new PairMembership(data, root.count);
      data = encodePairMembership(
        {
          ...r,
          body: Uint32Array.from(r.body.values()),
          title: Uint32Array.from(r.title.values()),
          context: changes.get(key),
        },
        root.count,
      );
      patched++;
    }
    entries.push({ a, b, data });
  }
  const encoded = encodePairMembershipPacket(entries);
  Object.assign(leaf, await store.append(encoded), { bytes: encoded.length });
}
await store.flush();
const common = raw.subarray(table + count * 16),
  metadata = {
    ...router.metadata,
    baseGeneration: root.generation,
    positionObjects: report.objects,
  };
await writeFile(
  pairs + "/router.bin",
  encodePairRouter(metadata, nodes, leaves, common),
);
await writeFile(
  pairs + "/positions-attached.json",
  JSON.stringify(
    {
      generation: metadata.generation,
      baseGeneration: root.generation,
      patched,
      objects: report.objects.length,
    },
    null,
    2,
  ),
);
console.log("Attached", patched, "pair position directories");
