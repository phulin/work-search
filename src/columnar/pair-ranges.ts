import { concat, u32, view } from "./format.js";
export interface ExactPairRanges {
  a: number;
  b: number;
  generation: string;
  ranges: { object: number; offset: number; length: number }[];
}
const MAGIC = 0x31525045;
export function isCompletePairRanges(data: Uint8Array) {
  return data.length >= 4 && view(data).getUint32(0, true) === MAGIC;
}
/** Complete position/context stream extents, stored with routed membership. */
export function encodeCompletePairRanges(p: ExactPairRanges) {
  if (!/^[a-f0-9]{64}$/.test(p.generation) || !p.ranges.length)
    throw Error("Invalid complete pair ranges");
  const header = new Uint8Array(48),
    v = view(header);
  [MAGIC, p.a, p.b, p.ranges.length].forEach((n, i) =>
    v.setUint32(i * 4, n, true),
  );
  for (let i = 0; i < 32; i++)
    header[16 + i] = parseInt(p.generation.slice(i * 2, i * 2 + 2), 16);
  return concat([
    header,
    u32(p.ranges.flatMap((r) => [r.object, r.offset, r.length])),
  ]);
}
export function decodeCompletePairRanges(data: Uint8Array): ExactPairRanges {
  const v = view(data);
  if (
    !isCompletePairRanges(data) ||
    data.length < 60 ||
    data.length !== 48 + v.getUint32(12, true) * 12
  )
    throw Error("Invalid complete pair ranges");
  const ranges: ExactPairRanges["ranges"] = [];
  for (let at = 48; at < data.length; at += 12) {
    const r = {
      object: v.getUint32(at, true),
      offset: v.getUint32(at + 4, true),
      length: v.getUint32(at + 8, true),
    };
    if (!r.length || r.offset + r.length > 32 * 1048576)
      throw Error("Invalid complete pair extent");
    ranges.push(r);
  }
  return {
    a: v.getUint32(4, true),
    b: v.getUint32(8, true),
    generation: [...data.subarray(16, 48)]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join(""),
    ranges,
  };
}
