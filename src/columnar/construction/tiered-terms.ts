import { Reader, Memory, Lru } from "../storage.js";
import { ColumnarR2 } from "../r2.js";
import { type Root, type Ref } from "../format.js";
import {
  decodeDirectoryBlock,
  encodeDirectoryBlock,
  type DirectoryTerm,
} from "../term-directory.js";
import { encodeTermShard } from "../term-shard.js";
import { ObjectStore, PackedWriter } from "./finish.js";
import type { BuildStore, Chunk } from "./runs.js";

export interface HotTerms {
  count: number;
  df: number;
  lastId: number;
}
export const isHotTerm = (t: DirectoryTerm, hot: HotTerms) =>
  t.df > hot.df || (t.df === hot.df && t.id <= hot.lastId);
async function transform(data: Uint8Array, kind: "gzip" | "gunzip") {
  return new Uint8Array(
    await new Response(
      new Response(data as BodyInit).body!.pipeThrough(
        kind === "gzip"
          ? new CompressionStream("gzip")
          : new DecompressionStream("gzip"),
      ),
    ).arrayBuffer(),
  );
}

/** Bounded native finalization: all payloads stay in R2. The coordinator sees
 * compressed hot metadata and direct cold-shard references, never postings. */
export async function finishTieredTerms(
  store: BuildStore,
  root: Root,
  blocks: Chunk[],
  hot: HotTerms,
  objectBase: number,
) {
  if (
    !blocks.length ||
    blocks.length > 8 ||
    !Number.isInteger(hot.df) ||
    hot.df < 1 ||
    !Number.isInteger(hot.lastId) ||
    hot.lastId < 0
  )
    throw Error("Invalid tiered term job");
  const memory = new Memory();
  memory.pages = new Lru(4 * 1048576);
  const reader = new Reader(root, new ColumnarR2(store.bucket), memory),
    objects = new ObjectStore(store, objectBase),
    writer = new PackedWriter(objects),
    bundled: [string, DirectoryTerm][] = [],
    cold: { first: string; count: number; ref: Ref }[] = [];
  let pending: [string, DirectoryTerm][] = [],
    inline: { ref: Ref; data: Uint8Array }[] = [],
    bytes = 0,
    inlineTerms = 0,
    terms = 0;
  const flush = async () => {
    if (!pending.length) return;
    const metadata = await transform(encodeDirectoryBlock(pending), "gzip"),
      packet = encodeTermShard(metadata, inline);
    cold.push({
      first: pending[0][0],
      count: pending.length,
      ref: await writer.put(packet),
    });
    pending = [];
    inline = [];
    bytes = 0;
  };
  for (const block of blocks) {
    const entries = decodeDirectoryBlock(
      await transform(await store.get(block), "gunzip"),
      root.count,
    );
    for (const [word, term] of entries) {
      terms++;
      if (isHotTerm(term, hot)) {
        bundled.push([word, term]);
        continue;
      }
      const small =
          !term.tree.height &&
          !term.frequencyParts?.length &&
          !term.positionalParts?.length &&
          term.frequencies[2] + term.positional[2] <= 4096,
        estimate =
          128 +
          new TextEncoder().encode(word).length +
          (small ? term.frequencies[2] + term.positional[2] + 32 : 0);
      if (
        pending.length &&
        (pending.length >= 512 || bytes + estimate > 128 * 1024)
      )
        await flush();
      pending.push([word, term]);
      bytes += estimate;
      if (small) {
        const refs = [term.frequencies, term.positional],
          data = await reader.packets(refs);
        // Own the small copied spans; reader pages may be evicted before flush.
        for (let i = 0; i < refs.length; i++)
          inline.push({ ref: refs[i], data: Uint8Array.from(data[i]) });
        inlineTerms++;
      }
    }
  }
  await flush();
  await writer.flush();
  const metadata = await transform(encodeDirectoryBlock(bundled), "gzip");
  return {
    terms,
    hotTerms: bundled.length,
    inlineTerms,
    hot: bundled.length
      ? {
          first: bundled[0][0],
          count: bundled.length,
          ref: await store.put(metadata),
        }
      : undefined,
    cold,
    objects: objects.objects,
    reads: reader.stats.requests,
    readBytes: reader.stats.bytes,
  };
}
