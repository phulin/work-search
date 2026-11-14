/** Independently read every inline/external context record. Check that all
 * three columns exist, framing is exact, and every pair/field count agrees. */
import { readFile, writeFile } from "node:fs/promises";
import { deserialize } from "node:v8";
import { PairRouter } from "../src/columnar/pair-router.js";
import { unpack, view } from "../src/columnar/format.js";
import { readVarint } from "../src/columnar/compact-integers.js";
import {
  decodeCompletePairRanges,
  isCompletePairRanges,
} from "../src/columnar/pair-ranges.js";
const [index] = process.argv.slice(2);
if (!index) throw Error("Usage: validate-pair-context.ts INDEX");
const start = performance.now(),
  router = new PairRouter(await readFile(index + "/router.bin")),
  complete = deserialize(await readFile(index + "/context-complete.bin")),
  plans = complete.plans,
  counts = {
    pairs: 0,
    inlinePairs: 0,
    externalPairs: 0,
    inlineOccurrences: 0,
    externalOccurrences: 0,
    bodyOccurrences: 0,
    titleOccurrences: 0,
  },
  byId = new Map<number, Map<number, any>>();
if (
  !router.metadata.completeContext ||
  router.metadata.generation !== complete.generation
)
  throw Error("Not a complete generation");
for (const p of plans) {
  if (!byId.has(p.aId)) byId.set(p.aId, new Map());
  byId
    .get(p.aId)!
    .set(p.bId, { ...p, actual: [0, 0, 0, 0, 0], last: [-1, -1, -1] });
}
function span(
  data: Uint8Array,
  at: number,
  count: number,
  delta: boolean,
  end: number,
) {
  if (count === 1) return readVarint(data, at).next;
  if (at >= end) throw Error("Missing context column");
  const width = data[at++];
  if (width > 32) throw Error("Invalid context width");
  if (delta) at = readVarint(data, at).next;
  at += Math.ceil(((count - (delta ? 1 : 0)) * width) / 32) * 4;
  if (at > end) throw Error("Truncated context column");
  return at;
}
function field(data: Uint8Array, n: number) {
  if (!n) {
    if (data.length) throw Error("Unexpected empty-field bytes");
    return 0;
  }
  let starts: Uint32Array, bytes: Uint8Array;
  if (n === 1) {
    starts = Uint32Array.of(0, data.length);
    bytes = data;
  } else {
    const length = view(data).getUint32(0, true);
    starts = unpack(data.subarray(4, 4 + length));
    bytes = data.subarray(4 + length);
    if (starts.length !== n + 1 || starts[0] || starts[n] !== bytes.length)
      throw Error("Context field directory mismatch");
  }
  let total = 0;
  for (let i = 0; i < n; i++) {
    const end = starts[i + 1],
      c = readVarint(bytes, starts[i]);
    if (!c.value || end <= starts[i] || c.value > bytes.length * 32)
      throw Error("Invalid occurrence count");
    let at = span(bytes, c.next, c.value, true, end);
    at = span(bytes, at, c.value, false, end);
    at = span(bytes, at, c.value, false, end);
    if (at !== end) throw Error("Context columns do not fill occurrence span");
    total += c.value;
  }
  return total;
}
function context(data: Uint8Array, bd: number, td: number) {
  const v = view(data);
  if (data.length < 12 || v.getUint32(0, true) !== 0x31584343)
    throw Error("Missing previous/next context");
  const bn = v.getUint32(4, true),
    tn = v.getUint32(8, true);
  if (12 + bn + tn !== data.length) throw Error("Context framing mismatch");
  return [
    field(data.subarray(12, 12 + bn), bd),
    field(data.subarray(12 + bn), td),
  ];
}
let object = -1,
  raw = new Uint8Array();
for (const p of [...router.packets()].sort(
  (a, b) => a.object - b.object || a.offset - b.offset,
)) {
  if (p.object !== object) {
    object = p.object;
    raw = await readFile(index + `/objects/pairs-${object}.bin`);
  }
  const packet = raw.subarray(p.offset, p.offset + p.bytes),
    v = view(packet);
  for (let i = 0; i < p.pairs; i++) {
    const off = 16 + i * 16,
      from = v.getUint32(off + 8, true),
      length = v.getUint32(off + 12, true),
      data = packet.subarray(from, from + length),
      h = [];
    if (data[0] !== 4) throw Error("Unexpected pair record");
    let at = 1;
    for (let j = 0; j < 11; j++) {
      const r = readVarint(data, at);
      h.push(r.value);
      at = r.next;
    }
    if (at + h[7] + h[8] + h[9] !== length || !h[9])
      throw Error("Pair without context");
    const c = data.subarray(at + h[7] + h[8]);
    counts.pairs++;
    counts.bodyOccurrences += h[5];
    counts.titleOccurrences += h[6];
    if (isCompletePairRanges(c)) {
      const r = decodeCompletePairRanges(c),
        plan = byId.get(h[0])?.get(h[1]);
      if (
        !plan ||
        r.generation !== router.metadata.generation ||
        r.a !== h[0] ||
        r.b !== h[1] ||
        JSON.stringify(r.ranges) !== JSON.stringify(plan.ranges)
      )
        throw Error("External context locator mismatch");
      for (const [j, k] of [
        [2, "df"],
        [3, "bodyDf"],
        [4, "titleDf"],
        [5, "bodyOccurrences"],
        [6, "titleOccurrences"],
      ] as const)
        if (plan[k] !== h[j]) throw Error("External field statistics mismatch");
      counts.externalPairs++;
    } else {
      const occurrences = context(c, h[3], h[4]);
      if (occurrences[0] !== h[5] || occurrences[1] !== h[6])
        throw Error("Inline occurrence coverage mismatch");
      counts.inlinePairs++;
      counts.inlineOccurrences += occurrences[0] + occurrences[1];
    }
  }
}
console.log("Validated all routed pair records", JSON.stringify(counts));
let checkedObjects = 0;
for (const o of complete.objects) {
  const bytes = await readFile(index + `/objects/positions-${o.id}.bin`);
  if (bytes.length !== o.bytes) throw Error("Position object size mismatch");
  for (let at = 0; at < bytes.length;) {
    const v = view(bytes.subarray(at)),
      bn = v.getUint32(12, true),
      tn = v.getUint32(16, true),
      cn = v.getUint32(20, true),
      length = 24 + bn + tn + cn,
      plan = byId.get(v.getUint32(4, true))?.get(v.getUint32(8, true));
    if (
      v.getUint32(0, true) !== 0x34505043 ||
      !plan ||
      length > 65536 ||
      at + length > bytes.length ||
      !plan.ranges.some(
        (r: any) =>
          r.object === o.id &&
          r.offset <= at &&
          at + length <= r.offset + r.length,
      )
    )
      throw Error("Invalid position packet identity");
    const body = bn
        ? unpack(bytes.subarray(at + 24, at + 24 + bn))
        : new Uint32Array(),
      title = tn
        ? unpack(bytes.subarray(at + 24 + bn, at + 24 + bn + tn))
        : new Uint32Array(),
      occ = context(
        bytes.subarray(at + 24 + bn + tn, at + length),
        body.length,
        title.length,
      );
    for (const [f, docs] of [body, title].entries())
      for (let i = 0; i < docs.length; i++) {
        if (i && docs[i] <= docs[i - 1])
          throw Error("Unsorted position membership");
        if (docs[i] !== plan.last[f + 1]) plan.actual[f + 1]++;
        plan.last[f + 1] = docs[i];
      }
    let a = 0,
      b = 0;
    while (a < body.length || b < title.length) {
      const doc = Math.min(body[a] ?? Infinity, title[b] ?? Infinity);
      if (doc !== plan.last[0]) plan.actual[0]++;
      plan.last[0] = doc;
      if (body[a] === doc) a++;
      if (title[b] === doc) b++;
    }
    plan.actual[3] += occ[0];
    plan.actual[4] += occ[1];
    counts.externalOccurrences += occ[0] + occ[1];
    at += length;
  }
  if (++checkedObjects % 100 === 0)
    console.log(
      "Validated position objects",
      checkedObjects,
      "/",
      complete.objects.length,
    );
}
for (const inner of byId.values())
  for (const p of inner.values())
    for (const [i, k] of [
      "df",
      "bodyDf",
      "titleDf",
      "bodyOccurrences",
      "titleOccurrences",
    ].entries())
      if (p.actual[i] !== p[k])
        throw Error("Decoded external coverage mismatch: " + p.id + " " + k);
for (const k of Object.keys(counts) as (keyof typeof counts)[])
  if (counts[k] !== complete.counts[k])
    throw Error("Global context coverage mismatch: " + k);
await writeFile(
  index + "/context-validation.json",
  JSON.stringify(
    {
      generation: router.metadata.generation,
      counts,
      positionObjects: checkedObjects,
      columnsPerOccurrence: 3,
      seconds: (performance.now() - start) / 1000,
      note: "Every encoded context span and per-pair/field count checked. Span framing is checked without expanding every integer value; independent exhaustive query tests check matching semantics.",
    },
    null,
    2,
  ),
);
console.log("Complete context coverage validated", JSON.stringify(counts));
