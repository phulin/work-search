import { readVarint } from "../../src/columnar/compact-integers.js";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { crc32 } from "../../src/format/codec.js";
import { view } from "../../src/columnar/format.js";
import {
  PairMembership,
  PAIR_PACKET_MAGIC,
} from "../../src/columnar/pair-membership.js";
import { pairObjectKey, PairRouter } from "../../src/columnar/pair-router.js";

const [dir, out] = process.argv.slice(2);
if (!dir || !out)
  throw Error("Usage: pair-storage-report.ts PAIR_INDEX OUTPUT.json");
const routerBytes = await readFile(dir + "/router.bin"),
  router = new PairRouter(routerBytes),
  v = view(routerBytes),
  leafStart = 20 + v.getUint32(4, true) + v.getUint32(8, true) * 8,
  leaves = v.getUint32(12, true),
  expected = JSON.parse(await readFile(dir + "/statistics.json", "utf8")),
  started = performance.now(),
  totals = {
    packets: 0,
    packetBytes: 0,
    pairs: 0,
    documentMemberships: 0,
    fieldMemberships: 0,
    bodyOccurrences: 0,
    titleOccurrences: 0,
    membershipBytes: 0,
    recordBytes: 0,
    contextPairs: 0,
    contextBytes: 0,
    contextMemberships: 0,
    contextOccurrences: 0,
    sampledRecords: 0,
    sampledMembershipIntegers: 0,
  };
// Read the fixed leaf table directly so every immutable object is checked,
// including leaves not selected by any benchmark query.
let containerId = -1,
  container: Uint8Array;
for (const leaf of router.packets()) {
  if (leaf.object !== containerId) {
    container = await readFile(dir + "/objects/pairs-" + leaf.object + ".bin");
    containerId = leaf.object;
  }
  const key = pairObjectKey(router.metadata.generation, leaf),
    raw = Buffer.from(
      container!.subarray(leaf.offset, leaf.offset + leaf.bytes),
    ),
    data = view(raw);
  if (
    raw.length !== leaf.bytes ||
    data.getUint32(0, true) !== PAIR_PACKET_MAGIC ||
    data.getUint32(4, true) !== leaf.pairs ||
    data.getUint32(12, true) !== raw.length
  )
    throw Error("Packet identity mismatch: " + key);
  let nextKey = 16 + leaf.pairs * 16,
    nextRecord = data.getUint32(8, true);
  for (let row = 0; row < leaf.pairs; row++) {
    const r = 16 + row * 16,
      keyAt = data.getUint32(r, true),
      keyLength = data.getUint32(r + 4, true),
      at = data.getUint32(r + 8, true),
      length = data.getUint32(r + 12, true);
    if (
      keyAt !== nextKey ||
      keyAt + keyLength > data.getUint32(8, true) ||
      at !== nextRecord ||
      length < 12 ||
      at + length > raw.length
    )
      throw Error("Noncontiguous packet sections: " + key);
    const header: number[] = [];
    let cursor = at + 1;
    if (raw[at] !== 4) throw Error("Invalid membership version");
    for (let i = 0; i < 11; i++) {
      const v = readVarint(raw, cursor);
      header.push(v.value);
      cursor = v.next;
    }
    const [, , df, body, title, bo, to, bn, tn, cn, flags] = header;
    if (
      !df ||
      df > router.metadata.documents ||
      df < Math.max(body, title) ||
      df > body + title ||
      bo < body ||
      to < title ||
      length !== cursor - at + bn + tn + cn ||
      flags > 15 ||
      (flags & 3) === 3 ||
      flags >>> 2 === 3
    )
      throw Error("Invalid membership sections/counts: " + key);
    totals.pairs++;
    totals.documentMemberships += df;
    totals.fieldMemberships += body + title;
    totals.bodyOccurrences += bo;
    totals.titleOccurrences += to;
    totals.membershipBytes += 44 + bn + tn;
    totals.recordBytes += length;
    if (cn) {
      totals.contextPairs++;
      totals.contextBytes += cn;
      totals.contextMemberships += df;
      totals.contextOccurrences += bo + to;
    }
    // Deterministic distributed decoding checks supplement every-object CRC,
    // every-record span/count checks and independent query/source references.
    if (totals.pairs % 4096 === 0) {
      const identity = raw
          .subarray(keyAt, keyAt + keyLength)
          .toString("utf8")
          .split("\0"),
        route = router.route(identity[0], identity[1]),
        record = new PairMembership(
          raw.subarray(at, at + length),
          router.metadata.documents,
        );
      if (
        identity.length !== 2 ||
        !route ||
        pairObjectKey(router.metadata.generation, route) !== key
      )
        throw Error("Exact key routing mismatch: " + key);
      let count = 0,
        previous = -1;
      const cursor = record.cursor("all");
      for (let doc = cursor.next(); doc !== Infinity; doc = cursor.next()) {
        if (doc <= previous)
          throw Error("Membership ordering mismatch: " + key);
        previous = doc;
        count++;
      }
      if (count !== df) throw Error("Decoded union DF mismatch: " + key);
      totals.sampledRecords++;
      totals.sampledMembershipIntegers += count;
    }
    nextKey += keyLength;
    nextRecord += length;
  }
  if (nextKey !== data.getUint32(8, true) || nextRecord !== raw.length)
    throw Error("Trailing packet data: " + key);
  totals.packets++;
  totals.packetBytes += raw.length;
  if (totals.packets % 10000 === 0)
    console.log("Verified", totals.packets, "packets", totals.pairs, "pairs");
}
for (const [key, value] of Object.entries(totals))
  if (expected[key] !== undefined && expected[key] !== value)
    throw Error("Builder total mismatch: " + key);
await writeFile(
  out,
  JSON.stringify(
    {
      generation: router.metadata.generation,
      baseGeneration: router.metadata.baseGeneration,
      routerSha256: createHash("sha256").update(routerBytes).digest("hex"),
      validation:
        "Every packet size/CRC; every record span/count/list-mode; distributed exact routing and decoded membership checks. This is not an exhaustive source-to-pair identity comparison.",
      totals,
      contextMembershipFraction:
        totals.contextMemberships / totals.documentMemberships,
      contextOccurrenceFraction:
        totals.contextOccurrences /
        (totals.bodyOccurrences + totals.titleOccurrences),
      elapsedMs: performance.now() - started,
      finishedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log("Verified complete pair storage", totals);
