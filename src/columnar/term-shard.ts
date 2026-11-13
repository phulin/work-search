import { concat, refAt, view, writeRef, type Ref } from "./format.js";
import {
  decodeDirectoryBlock,
  directoryRetainedBytes,
  type DirectoryTerm,
} from "./term-directory.js";
import type { Reader } from "./storage.js";

/** Compressed dictionary metadata followed by uncompressed complete small
 * packets. Original addresses remain valid; the query reader reuses the bytes
 * returned by discovery instead of fetching those packet ranges again. */
export function encodeTermShard(
  metadata: Uint8Array,
  inline: { ref: Ref; data: Uint8Array }[],
) {
  const header = new Uint8Array(16 + inline.length * 16),
    v = view(header);
  [0x31535443, metadata.length, inline.length, header.length].forEach((n, i) =>
    v.setUint32(i * 4, n, true),
  );
  let at = header.length + metadata.length;
  for (const [i, item] of inline.entries()) {
    if (item.ref[2] !== item.data.length)
      throw Error("Inline term size mismatch");
    writeRef(v, 16 + i * 16, item.ref);
    v.setUint32(28 + i * 16, at, true);
    at += item.data.length;
  }
  return concat([header, metadata, ...inline.map((i) => i.data)]);
}

export class TermShard {
  private constructor(
    readonly entries: Map<string, DirectoryTerm>,
    readonly inline: { ref: Ref; data: Uint8Array }[],
    readonly bytes: number,
  ) {}
  static async decode(raw: Uint8Array, documents: number) {
    if (raw.length < 16 || view(raw).getUint32(0, true) !== 0x31535443)
      throw Error("Invalid term shard");
    // A shard may be a slice of a multi-page coalesced transfer. Its cached
    // inline spans must not retain that larger uncharged backing buffer.
    if (raw.byteLength !== raw.buffer.byteLength) raw = Uint8Array.from(raw);
    const v = view(raw),
      metadataBytes = v.getUint32(4, true),
      count = v.getUint32(8, true),
      start = v.getUint32(12, true);
    if (
      count > 8192 ||
      start !== 16 + count * 16 ||
      start + metadataBytes > raw.length
    )
      throw Error("Invalid term shard header");
    const metadata = new Uint8Array(
        await new Response(
          new Response(
            raw.subarray(start, start + metadataBytes) as BodyInit,
          ).body!.pipeThrough(new DecompressionStream("gzip")),
        ).arrayBuffer(),
      ),
      entries = decodeDirectoryBlock(metadata, documents),
      inline: { ref: Ref; data: Uint8Array }[] = [];
    // Only ranges belonging to this shard's dictionary may seed the reader.
    const allowed = new Set<string>();
    for (const t of entries.values())
      for (const r of [t.frequencies, t.positional]) allowed.add(r.join(":"));
    let next = start + metadataBytes;
    const seen = new Set<string>();
    for (let i = 0; i < count; i++) {
      const ref = refAt(v, 16 + i * 16),
        at = v.getUint32(28 + i * 16, true),
        key = ref.join(":");
      if (
        !ref[2] ||
        at !== next ||
        at + ref[2] > raw.length ||
        !allowed.has(key) ||
        seen.has(key)
      )
        throw Error("Invalid inline term address");
      inline.push({ ref, data: raw.subarray(at, at + ref[2]) });
      seen.add(key);
      next += ref[2];
    }
    if (next !== raw.length) throw Error("Trailing term shard data");
    return new TermShard(
      entries,
      inline,
      raw.length + directoryRetainedBytes(entries) + inline.length * 160,
    );
  }
  seed(reader: Reader, names: string[]) {
    for (const name of names) {
      const term = this.entries.get(name);
      if (!term) continue;
      for (const ref of [term.frequencies, term.positional]) {
        const span = this.inline.find((s) =>
          s.ref.every((n, i) => n === ref[i]),
        );
        if (span) reader.seed(span.ref, span.data);
      }
    }
  }
}
