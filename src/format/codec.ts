export const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  return c >>> 0;
});
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = (c >>> 8) ^ crcTable[(c ^ b) & 255];
  return (c ^ 0xffffffff) >>> 0;
}
export function varint(out: number[], n: number) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff)
    throw new Error("Integer overflow");
  while (n >= 128) {
    out.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
}
export function readVarint(b: Uint8Array, p: { i: number }): number {
  const first = b[p.i];
  if (first < 128) {
    p.i++;
    return first;
  }
  let n = 0,
    mul = 1;
  for (let j = 0; j < 5; j++) {
    if (p.i >= b.length) throw new Error("Truncated varint");
    const x = b[p.i++];
    n += (x & 127) * mul;
    if (!(x & 128)) {
      if (n > 0xffffffff || (j > 0 && x === 0))
        throw new Error("Invalid varint");
      return n;
    }
    mul *= 128;
  }
  throw new Error("Invalid varint");
}
export interface Posting {
  doc: number;
  body: number;
  title: number;
  bodyPositions?: number[];
  titlePositions?: number[];
}
export function encodePostings(list: Posting[]): Uint8Array {
  const out: number[] = [];
  varint(out, list.length);
  let previous = 0;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (
      p.doc < previous ||
      (i > 0 && p.doc === previous) ||
      (!p.body && !p.title)
    )
      throw new Error("Invalid posting");
    varint(out, p.doc - previous);
    varint(out, p.body);
    varint(out, p.title);
    previous = p.doc;
    for (const [count, positions] of [
      [p.body, p.bodyPositions],
      [p.title, p.titlePositions],
    ] as const) {
      if (count !== (positions?.length ?? 0))
        throw new Error("Position frequency mismatch");
      let prev = 0;
      for (let j = 0; j < count; j++) {
        const position = positions![j];
        if (position < prev || (j > 0 && position === prev))
          throw new Error("Unsorted positions");
        varint(out, position - prev);
        prev = position;
      }
    }
  }
  return Uint8Array.from(out);
}
export interface DecodedPostings {
  positionsComplete?: boolean;
  blocks?: import("./blocks.js").Block[];
  blockRows?: Uint32Array;
  frequencyCrc?: number;
  docs: Uint32Array;
  body: Uint32Array;
  title: Uint32Array;
  bytes: Uint8Array;
  positionOffsets?: Uint32Array;
  positionEnds?: Uint32Array;
}
export function decodePostings(
  b: Uint8Array,
  expected?: number,
  withPositions = false,
): DecodedPostings {
  const p = { i: 0 },
    n = readVarint(b, p);
  if (
    (expected !== undefined && n !== expected) ||
    n > Math.floor((b.length - p.i) / 4)
  )
    throw new Error("Invalid posting count");
  const docs = new Uint32Array(n),
    body = new Uint32Array(n),
    title = new Uint32Array(n),
    positionOffsets = withPositions ? new Uint32Array(n) : undefined;
  let doc = 0;
  for (let i = 0; i < n; i++) {
    const d = readVarint(b, p);
    if (i && d === 0) throw new Error("Unsorted postings");
    doc += d;
    if (doc > 0xffffffff) throw new Error("Document overflow");
    docs[i] = doc;
    body[i] = readVarint(b, p);
    title[i] = readVarint(b, p);
    if (!body[i] && !title[i]) throw new Error("Empty frequency");
    if (body[i] + title[i] > b.length - p.i)
      throw new Error("Invalid position count");
    if (positionOffsets) positionOffsets[i] = p.i;
    for (const count of [body[i], title[i]]) {
      let position = 0;
      for (let j = 0; j < count; j++) {
        const delta = readVarint(b, p);
        if (j && delta === 0) throw new Error("Unsorted positions");
        position += delta;
        if (position > 0xffffffff) throw new Error("Position overflow");
      }
    }
  }
  if (p.i !== b.length) throw new Error("Trailing posting data");
  return { docs, body, title, bytes: b, positionOffsets };
}
export function postingPositions(
  list: DecodedPostings,
  row: number,
): { body: Uint32Array; title: Uint32Array } {
  if (!list.positionOffsets || row < 0 || row >= list.docs.length)
    throw new Error("Positions unavailable");
  const bytes = list.positionEnds
    ? list.bytes.subarray(
        list.positionOffsets[row],
        row % 256 === 255 || row === list.docs.length - 1
          ? list.positionEnds[Math.floor(row / 256)]
          : list.positionOffsets[row + 1],
      )
    : list.bytes;
  const p = { i: list.positionEnds ? 0 : list.positionOffsets[row] };
  const result = {
    body: new Uint32Array(list.body[row]),
    title: new Uint32Array(list.title[row]),
  };
  for (const field of [result.body, result.title]) {
    let value = 0;
    for (let i = 0; i < field.length; i++) {
      const delta = readVarint(bytes, p);
      if (i && !delta) throw new Error("Unsorted positions");
      value += delta;
      if (value > 0xffffffff) throw new Error("Position overflow");
      field[i] = value;
    }
  }
  if (list.positionEnds && p.i !== bytes.length)
    throw new Error("Trailing position data");
  return result;
}

// V4 independently addressable streams. The v3 codec above is retained only
// for frozen reference tests; the Worker reads these frequency/position codecs.
export function encodeFrequencies(list: Posting[]): Uint8Array {
  const out: number[] = [];
  varint(out, list.length);
  let previous = 0;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p.doc < previous || (i && p.doc === previous) || (!p.body && !p.title))
      throw new Error("Invalid posting");
    varint(out, p.doc - previous);
    varint(out, p.body);
    varint(out, p.title);
    previous = p.doc;
  }
  return Uint8Array.from(out);
}
export function encodePositions(
  list: Posting[],
  frequencyCrc = crc32(encodeFrequencies(list)),
): Uint8Array {
  const out: number[] = [];
  varint(out, list.length);
  for (let i = 0; i < 4; i++) out.push((frequencyCrc >>> (i * 8)) & 255);
  for (const p of list)
    for (const [count, positions] of [
      [p.body, p.bodyPositions],
      [p.title, p.titlePositions],
    ] as const) {
      if (count !== (positions?.length ?? 0))
        throw new Error("Position frequency mismatch");
      let previous = 0;
      for (let i = 0; i < count; i++) {
        const position = positions![i];
        if (position < previous || (i && position === previous))
          throw new Error("Unsorted positions");
        varint(out, position - previous);
        previous = position;
      }
    }
  return Uint8Array.from(out);
}
export function decodeFrequencies(
  bytes: Uint8Array,
  expected?: number,
  expectedCrc?: number,
  output?: { list: DecodedPostings; offset: number },
): DecodedPostings {
  const frequencyCrc = crc32(bytes);
  if (expectedCrc !== undefined && frequencyCrc !== expectedCrc)
    throw new Error("Frequency checksum mismatch");
  const p = { i: 0 },
    n = readVarint(bytes, p);
  if (
    (expected !== undefined && n !== expected) ||
    n > Math.floor((bytes.length - p.i) / 3)
  )
    throw new Error("Invalid posting count");
  if (
    output &&
    (!Number.isInteger(output.offset) ||
      output.offset < 0 ||
      output.offset + n > output.list.docs.length ||
      output.offset + n > output.list.body.length ||
      output.offset + n > output.list.title.length)
  )
    throw new Error("Invalid posting output range");
  const docs = output
      ? output.list.docs.subarray(output.offset, output.offset + n)
      : new Uint32Array(n),
    body = output
      ? output.list.body.subarray(output.offset, output.offset + n)
      : new Uint32Array(n),
    title = output
      ? output.list.title.subarray(output.offset, output.offset + n)
      : new Uint32Array(n);
  let doc = 0;
  for (let i = 0; i < n; i++) {
    const delta = readVarint(bytes, p);
    if (i && delta === 0) throw new Error("Unsorted postings");
    doc += delta;
    if (doc > 0xffffffff) throw new Error("Document overflow");
    docs[i] = doc;
    body[i] = readVarint(bytes, p);
    title[i] = readVarint(bytes, p);
    if (!body[i] && !title[i]) throw new Error("Empty frequency");
  }
  if (p.i !== bytes.length) throw new Error("Trailing frequency data");
  return { docs, body, title, bytes: new Uint8Array(0), frequencyCrc };
}
export function attachPositions(
  frequencies: DecodedPostings,
  bytes: Uint8Array,
  expectedCrc?: number,
): void {
  if (expectedCrc !== undefined && crc32(bytes) !== expectedCrc)
    throw new Error("Position checksum mismatch");
  const p = { i: 0 },
    n = readVarint(bytes, p);
  if (
    n !== frequencies.docs.length ||
    p.i + 4 > bytes.length ||
    n > bytes.length - p.i - 4
  )
    throw new Error("Invalid position count");
  const boundCrc = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(p.i, true);
  p.i += 4;
  if (
    frequencies.frequencyCrc === undefined ||
    boundCrc !== frequencies.frequencyCrc
  )
    throw new Error("Frequency/position stream mismatch");
  const offsets = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    offsets[i] = p.i;
    if (frequencies.body[i] + frequencies.title[i] > bytes.length - p.i)
      throw new Error("Invalid position count");
    for (const count of [frequencies.body[i], frequencies.title[i]]) {
      let position = 0;
      for (let j = 0; j < count; j++) {
        const delta = readVarint(bytes, p);
        if (j && delta === 0) throw new Error("Unsorted positions");
        position += delta;
        if (position > 0xffffffff) throw new Error("Position overflow");
      }
    }
  }
  if (p.i !== bytes.length) throw new Error("Trailing position data");
  frequencies.bytes = bytes;
  frequencies.positionOffsets = offsets;
}
