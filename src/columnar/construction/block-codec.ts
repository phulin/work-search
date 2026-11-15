import { concat, u32, view } from "../format.js";

export type RunCodec = "raw" | "gzip" | "delta-gzip-v3";
export async function transformBlock(data: Uint8Array, inflate = false) {
  return new Uint8Array(
    await new Response(
      new Response(data as BodyInit).body!.pipeThrough(
        inflate
          ? new DecompressionStream("gzip")
          : new CompressionStream("gzip"),
      ),
    ).arrayBuffer(),
  );
}
function integer(out: number[], n: number) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff)
    throw Error("Invalid run integer");
  do {
    const b = n % 128;
    n = Math.floor(n / 128);
    out.push(b | (n ? 128 : 0));
  } while (n);
}
function take(data: Uint8Array, at: { n: number }) {
  let n = 0,
    scale = 1;
  for (let i = 0; i < 5 && at.n < data.length; i++) {
    const b = data[at.n++];
    n += (b & 127) * scale;
    if (!(b & 128)) {
      if (n > 0xffffffff) break;
      return n;
    }
    scale *= 128;
  }
  throw Error("Invalid compact run integer");
}
/** Staging only: serving records and score precision are unchanged. A block
 * starts its own document delta chain, including when it starts inside a term. */
export async function encodeRunBlock(raw: Uint8Array, codec: RunCodec) {
  if (codec === "raw") return raw;
  if (codec === "gzip") return transformBlock(raw);
  const out: number[] = [];
  let doc = 0;
  for (let at = 0; at < raw.length;) {
    const v = view(raw.subarray(at)),
      length = v.getUint32(0, true),
      kind = v.getUint32(4, true);
    if (length < 8 || at + length > raw.length)
      throw Error("Invalid run record");
    out.push(kind);
    if (kind === 1) {
      integer(out, length - 12);
      integer(out, v.getUint32(8, true));
      for (let p = 12; p < length; p++) out.push(raw[at + p]);
      doc = 0;
    } else if (kind === 2) {
      const next = v.getUint32(8, true),
        bn = v.getUint32(20, true),
        tn = v.getUint32(24, true);
      if (next < doc || length !== 28 + bn + tn)
        throw Error("Invalid run row order");
      for (const n of [
        next - doc,
        v.getUint32(12, true),
        v.getUint32(16, true),
        bn,
        tn,
      ])
        integer(out, n);
      // Position columns already use delta/block-packed integers. Keep them
      // independently decodable without an object or integer per occurrence.
      for (let p = 28; p < length; p++) out.push(raw[at + p]);
      doc = next;
    } else throw Error("Invalid run record kind");
    at += length;
  }
  return transformBlock(
    concat([u32([0x33524343, raw.length]), Uint8Array.from(out)]),
  );
}
export async function decodeRunBlock(
  bytes: Uint8Array,
  codec: RunCodec,
  rawBytes?: number,
) {
  if (codec === "raw") return bytes;
  const compact = await transformBlock(bytes, true);
  if (codec === "gzip") {
    if (rawBytes !== undefined && compact.length !== rawBytes)
      throw Error("Run length mismatch");
    return compact;
  }
  if (compact.length < 8 || view(compact).getUint32(0, true) !== 0x33524343)
    throw Error("Invalid compact run version");
  const size = view(compact).getUint32(4, true);
  if (size !== rawBytes || size > 64 * 1048576)
    throw Error("Invalid compact run size");
  const raw = new Uint8Array(size),
    target = view(raw),
    at = { n: 8 };
  let p = 0,
    doc = 0;
  while (at.n < compact.length) {
    const kind = compact[at.n++];
    let length: number, prefix: number;
    if (kind === 1) {
      const n = take(compact, at),
        df = take(compact, at);
      length = 12 + n;
      prefix = 12;
      doc = 0;
      if (p + length > raw.length) throw Error("Compact term overflow");
      target.setUint32(p + 8, df, true);
    } else if (kind === 2) {
      doc += take(compact, at);
      const bl = take(compact, at),
        tl = take(compact, at),
        bn = take(compact, at),
        tn = take(compact, at);
      length = 28 + bn + tn;
      prefix = 28;
      if (doc > 0xffffffff || p + length > raw.length)
        throw Error("Compact row overflow");
      [doc, bl, tl, bn, tn].forEach((n, i) =>
        target.setUint32(p + 8 + i * 4, n, true),
      );
    } else throw Error("Invalid compact row kind");
    if (at.n + length - prefix > compact.length)
      throw Error("Truncated compact run");
    target.setUint32(p, length, true);
    target.setUint32(p + 4, kind, true);
    raw.set(compact.subarray(at.n, at.n + length - prefix), p + prefix);
    at.n += length - prefix;
    p += length;
  }
  if (p !== raw.length) throw Error("Truncated compact run");
  return raw;
}
