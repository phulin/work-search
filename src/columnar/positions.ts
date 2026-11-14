import { concat, pack, u32, view } from "./format.js";
import { encodeSpan, decodeSpan, packedAt } from "./compact-integers.js";

const MAGIC = 0x34505343;
export function encodePositions(
  rows: { body: ArrayLike<number>; title: ArrayLike<number> }[],
) {
  if (!rows.length || rows.length > 128)
    throw Error("Invalid positional block count");
  const spans: Uint8Array[] = [],
    offsets = [0];
  for (const row of rows)
    for (const field of [row.body, row.title]) {
      const span = encodeSpan(field, true);
      spans.push(span);
      offsets.push(offsets.at(-1)! + span.length);
    }
  const directory = pack(offsets);
  return concat([
    u32([MAGIC, rows.length, directory.length]),
    directory,
    ...spans,
  ]);
}
export function positionSpan(
  data: Uint8Array,
  row: number,
  field: number,
  count: number,
  observe?: (bytes: number) => void,
) {
  if (data.length < 24) throw Error("Truncated positional block");
  const v = view(data),
    n = v.getUint32(4, true),
    bytes = v.getUint32(8, true);
  if (
    v.getUint32(0, true) !== MAGIC ||
    !n ||
    n > 128 ||
    !Number.isInteger(row) ||
    row < 0 ||
    row >= n ||
    (field !== 0 && field !== 1) ||
    12 + bytes > data.length
  )
    throw Error("Invalid positional block");
  const offsets = data.subarray(12, 12 + bytes),
    base = 12 + bytes;
  if (
    view(offsets).getUint32(0, true) !== n * 2 + 1 ||
    packedAt(offsets, 0) ||
    base + packedAt(offsets, n * 2) !== data.length
  )
    throw Error("Invalid positional directory");
  const index = row * 2 + field,
    from = packedAt(offsets, index),
    end = packedAt(offsets, index + 1);
  if (end < from || base + end > data.length)
    throw Error("Invalid positional address");
  const raw = data.subarray(base + from, base + end),
    result = decodeSpan(raw, 0, count, true);
  if (result.next !== raw.length) throw Error("Invalid positional span");
  observe?.(raw.length);
  return result.values;
}
