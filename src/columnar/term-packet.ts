import {
  concat,
  u32,
  view,
  decodeScores,
  unpack,
  type Branch,
  type Scores,
  type Ref,
} from "./format.js";
export interface PacketBlock {
  branch: Branch;
  scores: Uint8Array;
  positions: Uint8Array;
}
/** Frequency packets own a flat block directory and a separately readable
 * locator column. Position payloads are independent contiguous bytes. */
export function encodeTermPacket(
  id: number,
  blocks: PacketBlock[],
  positionRefs?: Ref[],
) {
  const rows = blocks.reduce((n, b) => n + b.branch.count, 0),
    header = new Uint8Array(24 + blocks.length * 48),
    v = view(header),
    scores: Uint8Array[] = [],
    positions: Uint8Array[] = [u32([0x32505443, id])],
    handles = new Uint32Array(rows);
  v.setUint32(0, 0x33465443, true);
  v.setUint32(4, id, true);
  v.setUint32(8, rows, true);
  v.setUint32(12, blocks.length, true);
  let scoreAt = header.length,
    posAt = 8,
    row = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i],
      s = decodeScores(b.scores);
    if (s.docs.length !== b.branch.count)
      throw Error("Packet block count mismatch");
    const p = 24 + i * 48;
    for (const [j, n] of [
      b.branch.first,
      b.branch.last,
      b.branch.count,
      scoreAt,
      b.scores.length,
      ...(positionRefs?.[i] ?? [0, posAt, b.positions.length]),
    ].entries())
      v.setUint32(p + j * 4, n, true);
    v.setFloat64(p + 32, b.branch.b, true);
    v.setFloat64(p + 40, b.branch.t, true);
    scores.push(b.scores);
    positions.push(b.positions);
    handles.set(s.docs, row);
    row += s.docs.length;
    scoreAt += b.scores.length;
    posAt += b.positions.length;
  }
  v.setUint32(16, scoreAt, true);
  v.setUint32(20, posAt + (positionRefs ? 0x80000000 : 0), true);
  return {
    frequencies: concat([header, ...scores, new Uint8Array(handles.buffer)]),
    positional: concat(positions),
  };
}
export interface PacketColumns {
  id: number;
  docs: Uint32Array;
  body: Uint32Array;
  title: Uint32Array;
  b: Float64Array;
  t: Float64Array;
  locators: DataView;
  position: (
    row: number,
    field: number,
    data: Uint8Array | ((ref: Ref) => Uint8Array),
  ) => Uint32Array;
}
export function decodeTermPacket(
  data: Uint8Array,
  expectedId: number,
  positionBase: Ref = [0, 0, 0],
): PacketColumns {
  const v = view(data);
  if (
    data.length < 24 ||
    v.getUint32(0, true) !== 0x33465443 ||
    v.getUint32(4, true) !== expectedId
  )
    throw Error("Invalid frequency packet");
  const rows = v.getUint32(8, true),
    blocks = v.getUint32(12, true),
    handlesAt = v.getUint32(16, true),
    positionBytes = v.getUint32(20, true) & 0x7fffffff,
    absolutePositions = !!(v.getUint32(20, true) & 0x80000000);
  if (
    !rows ||
    !blocks ||
    24 + blocks * 48 > handlesAt ||
    handlesAt + rows * 4 !== data.length
  )
    throw Error("Invalid frequency packet directory");
  const docs = new Uint32Array(rows),
    body = new Uint32Array(rows),
    title = new Uint32Array(rows),
    b = new Float64Array(rows),
    t = new Float64Array(rows),
    starts = new Uint32Array(blocks + 1);
  let next = 0,
    previous = -1;
  for (let i = 0; i < blocks; i++) {
    const p = 24 + i * 48,
      at = v.getUint32(p + 12, true),
      n = v.getUint32(p + 16, true);
    if (at < 24 + blocks * 48 || at + n > handlesAt)
      throw Error("Invalid score block address");
    const s: Scores = decodeScores(data.subarray(at, at + n));
    if (
      s.docs.length !== v.getUint32(p + 8, true) ||
      next + s.docs.length > rows ||
      s.docs[0] <= previous
    )
      throw Error("Invalid packet document order");
    starts[i] = next;
    docs.set(s.docs, next);
    body.set(s.body, next);
    title.set(s.title, next);
    for (let j = 0; j < s.docs.length; j++) {
      b[next + j] = s.b.getFloat64(j * 8, true);
      t[next + j] = s.t.getFloat64(j * 8, true);
    }
    next += s.docs.length;
    previous = s.docs.at(-1)!;
  }
  starts[blocks] = next;
  if (next !== rows) throw Error("Packet frequency count mismatch");
  return {
    id: expectedId,
    docs,
    body,
    title,
    b,
    t,
    locators: new DataView(data.buffer, data.byteOffset + handlesAt, rows * 4),
    position(row, field, raw) {
      if (
        row < 0 ||
        row >= rows ||
        !Number.isInteger(row) ||
        field < 0 ||
        field > 1
      )
        throw Error("Invalid packet position row");
      if (typeof raw !== "function") {
        const pv = view(raw);
        if (
          raw.length !== positionBytes ||
          pv.getUint32(0, true) !== 0x32505443 ||
          pv.getUint32(4, true) !== expectedId
        )
          throw Error("Invalid positional packet");
      }
      let lo = 0,
        hi = blocks;
      while (lo + 1 < hi) {
        let m = (lo + hi) >>> 1;
        if (starts[m] <= row) lo = m;
        else hi = m;
      }
      const p = 24 + lo * 48,
        ref: Ref = [
          v.getUint32(p + 20, true),
          v.getUint32(p + 24, true),
          v.getUint32(p + 28, true),
        ],
        block =
          typeof raw === "function"
            ? raw(
                absolutePositions
                  ? ref
                  : [positionBase[0], positionBase[1] + ref[1], ref[2]],
              )
            : raw.subarray(ref[1], ref[1] + ref[2]),
        bv = view(block),
        count = bv.getUint32(0, true),
        r = row - starts[lo],
        base = 4 + (count + 1) * 4;
      if (block.length !== ref[2] || count !== starts[lo + 1] - starts[lo])
        throw Error("Positional block count mismatch");
      const from = base + bv.getUint32(4 + r * 4, true),
        end = base + bv.getUint32(8 + r * 4, true),
        bn = bv.getUint32(from, true);
      if (from + 4 + bn > end || end > block.length)
        throw Error("Invalid positional span");
      return unpack(
        field
          ? block.subarray(from + 4 + bn, end)
          : block.subarray(from + 4, from + 4 + bn),
      );
    },
  };
}
