import { crc32 } from "../format/codec.js";
export async function contentPointer(
  bucket: R2Bucket,
  generation: string,
  doc: number,
) {
  if (
    !/^[a-f0-9]{64}$/.test(generation) ||
    !Number.isInteger(doc) ||
    doc < 0 ||
    doc > 0xffffffff
  )
    throw Error("Invalid opinion address");
  const map = await bucket.get(`${generation}/contentmap-0.bin`, {
    range: { offset: doc * 32, length: 32 },
  });
  if (!map || map.customMetadata?.generation !== generation)
    throw Error("Opinion text is still being imported");
  const b = await map.arrayBuffer();
  if (b.byteLength !== 32) throw Error("Opinion not found");
  const v = new DataView(b);
  return Array.from({ length: 8 }, (_, i) => v.getUint32(i * 4, true));
}
export async function opinionInfo(
  bucket: R2Bucket,
  generation: string,
  doc: number,
) {
  const p = await contentPointer(bucket, generation, doc),
    o = await bucket.get(`${generation}/info-${p[4]}.bin`, {
      range: { offset: p[5], length: p[6] },
    });
  if (!o || o.customMetadata?.generation !== generation)
    throw Error("Opinion info unavailable");
  const b = new Uint8Array(await o.arrayBuffer());
  if (b.length !== p[6] || crc32(b) !== p[7])
    throw Error("Opinion info checksum mismatch");
  return JSON.parse(new TextDecoder().decode(b));
}
export async function opinionText(
  bucket: R2Bucket,
  generation: string,
  doc: number,
  pointer?: number[],
) {
  const p = pointer ?? (await contentPointer(bucket, generation, doc)),
    o = await bucket.get(`${generation}/content-${p[0]}.bin`, {
      range: { offset: p[1], length: p[2] },
    });
  if (!o || o.customMetadata?.generation !== generation)
    throw Error("Opinion text unavailable");
  return o.body.pipeThrough(new DecompressionStream("gzip"));
}
export async function excerpt(
  bucket: R2Bucket,
  generation: string,
  doc: number,
  terms: string[],
  pointer?: number[],
) {
  const reader = (
      await opinionText(bucket, generation, doc, pointer)
    ).getReader(),
    decoder = new TextDecoder(),
    wanted = new Set(terms);
  let tail = "",
    prefix = "",
    seen = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      const decoded = done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      const text = tail + decoded;
      if (prefix.length < 400) prefix = (prefix + decoded).slice(0, 400);
      for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu))
        if (
          (done || m.index! + m[0].length < text.length) &&
          (m.index !== 0 || seen <= tail.length) &&
          wanted.has(m[0].normalize("NFKC").toLowerCase())
        ) {
          const start = Math.max(0, m.index! - 160);
          return (
            (seen - tail.length + start > 0 ? "…" : "") +
            text.slice(start, m.index! + 240).trim() +
            "…"
          );
        }
      if (done) break;
      seen += decoded.length;
      tail = text.slice(-4096);
      if (seen > 8 * 1048576) break;
    }
    return prefix.trim() + (seen > prefix.length ? "…" : "");
  } finally {
    await reader.cancel().catch(() => {});
  }
}
