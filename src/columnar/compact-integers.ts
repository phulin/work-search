import { view } from "./format.js";

export function encodeVarints(values: ArrayLike<number>) {
  const bytes: number[] = [];
  for (let i = 0; i < values.length; i++) {
    let value = values[i];
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
      throw Error("Invalid compact integer");
    do {
      const byte = value & 127;
      value = Math.floor(value / 128);
      bytes.push(byte | (value ? 128 : 0));
    } while (value);
  }
  return Uint8Array.from(bytes);
}
export function readVarint(data: Uint8Array, at: number) {
  let value = 0,
    scale = 1;
  for (let i = 0; i < 5 && at < data.length; i++) {
    const byte = data[at++];
    value += (byte & 127) * scale;
    if (value > 0xffffffff) break;
    if (!(byte & 128)) return { value, next: at };
    scale *= 128;
  }
  throw Error("Invalid compact varint");
}

/** Counts belong to the parent column. Singleton spans are just one varint;
 * longer spans have one width byte, an optional delta base, and packed words. */
export function encodeSpan(values: ArrayLike<number>, delta = false) {
  const n = values.length;
  if (!n) return new Uint8Array();
  const prefix: number[] = [];
  const varint = (value: number) => {
    do {
      const byte = value & 127;
      value = Math.floor(value / 128);
      prefix.push(byte | (value ? 128 : 0));
    } while (value);
  };
  let max = 0,
    previous = 0;
  for (let i = 0; i < n; i++) {
    const value = values[i];
    if (
      !Number.isInteger(value) ||
      value < 0 ||
      value > 0xffffffff ||
      (delta && i > 0 && value <= previous)
    )
      throw Error("Invalid compact integer");
    if (!(delta && i === 0))
      max = Math.max(max, delta ? value - previous : value);
    previous = value;
  }
  if (n === 1) {
    varint(values[0]);
    return Uint8Array.from(prefix);
  }
  const width = max ? 32 - Math.clz32(max) : 0;
  prefix.push(width);
  if (delta) varint(values[0]);
  const count = delta ? n - 1 : n,
    out = new Uint8Array(prefix.length + Math.ceil((count * width) / 32) * 4),
    v = view(out);
  out.set(prefix);
  previous = values[0];
  for (let i = 0; i < count && width; i++) {
    const value = delta ? values[i + 1] - previous : values[i],
      bit = i * width,
      at = prefix.length + (bit >>> 5) * 4,
      shift = bit & 31;
    v.setUint32(at, v.getUint32(at, true) | (value << shift), true);
    if (shift + width > 32)
      v.setUint32(
        at + 4,
        v.getUint32(at + 4, true) | (value >>> (32 - shift)),
        true,
      );
    if (delta) previous = values[i + 1];
  }
  return out;
}
export function decodeSpan(
  data: Uint8Array,
  from: number,
  count: number,
  delta = false,
) {
  if (
    !Number.isInteger(count) ||
    count < 0 ||
    count > 0xffffffff ||
    from < 0 ||
    from > data.length
  )
    throw Error("Invalid compact span");
  const out = new Uint32Array(count),
    v = view(data);
  let at = from;
  const varint = () => {
    let value = 0,
      scale = 1;
    for (let i = 0; i < 5 && at < data.length; i++) {
      const byte = data[at++];
      value += (byte & 127) * scale;
      if (value > 0xffffffff) break;
      if (!(byte & 128)) return value;
      scale *= 128;
    }
    throw Error("Invalid compact varint");
  };
  if (!count) return { values: out, next: at };
  if (count === 1) {
    out[0] = varint();
    return { values: out, next: at };
  }
  if (at >= data.length) throw Error("Missing compact width");
  const width = data[at++];
  if (width > 32) throw Error("Invalid compact width");
  let previous = delta ? varint() : 0;
  if (delta) out[0] = previous;
  const n = delta ? count - 1 : count,
    end = at + Math.ceil((n * width) / 32) * 4,
    mask = width === 32 ? 0xffffffff : 2 ** width - 1;
  if (end > data.length) throw Error("Truncated compact span");
  for (let i = 0; i < n; i++) {
    const bit = i * width,
      p = at + (bit >>> 5) * 4,
      shift = bit & 31;
    let value = width ? v.getUint32(p, true) >>> shift : 0;
    if (shift + width > 32) value |= v.getUint32(p + 4, true) << (32 - shift);
    value = (value & mask) >>> 0;
    const next = delta ? previous + value : value;
    if (next > 0xffffffff || (delta && next <= previous))
      throw Error("Invalid compact delta");
    out[i + (delta ? 1 : 0)] = next;
    previous = next;
  }
  return { values: out, next: end };
}

/** Offset columns are non-delta packed integers, accessed without expanding
 * the other rows. This preserves random access to individual positional spans. */
export function packedAt(data: Uint8Array, index: number) {
  const v = view(data);
  if (data.length < 12) throw Error("Truncated offset column");
  const count = v.getUint32(0, true),
    width = data[8];
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= count ||
    width > 32 ||
    data[9] ||
    data.length !== 12 + Math.ceil((count * width) / 32) * 4
  )
    throw Error("Invalid offset column");
  const bit = index * width,
    p = 12 + (bit >>> 5) * 4,
    shift = bit & 31;
  let value = width ? v.getUint32(p, true) >>> shift : 0;
  if (shift + width > 32) value |= v.getUint32(p + 4, true) << (32 - shift);
  return (value & (width === 32 ? 0xffffffff : 2 ** width - 1)) >>> 0;
}
