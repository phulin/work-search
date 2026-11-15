import { BuildStore, jsonBytes, type Chunk } from "./runs.js";
import type { PairSelection } from "./pair-occurrences.js";
import { u32, view } from "../format.js";
export interface SelectionPackets {
  format: "selected-pairs-v3";
  documents: number;
  vocabulary: number;
  terms: Chunk;
  chunks: { first: number; last: number; ref: Chunk }[];
}
/** The finalizer needs a few descriptors, not the whole selection. Keep exact
 * counts in independently checked numeric blocks, packed into one object. */
export async function storeSelection(
  store: BuildStore,
  selection: PairSelection,
) {
  const parts: Uint8Array[] = [u32(selection.terms.map((t) => t.id))],
    ranges: { first: number; last: number }[] = [];
  for (let at = 0; at < selection.pairs.length; at += 256) {
    const rows = selection.pairs.slice(at, at + 256),
      raw = new Uint8Array(rows.length * 32),
      v = view(raw);
    rows.forEach((p, i) => {
      [p.key, p.a, p.b, p.df].forEach((n, j) =>
        v.setUint32(i * 32 + j * 4, n, true),
      );
      v.setFloat64(i * 32 + 16, p.occurrences, true);
      v.setFloat64(i * 32 + 24, p.cost, true);
    });
    parts.push(raw);
    ranges.push({ first: rows[0].key, last: rows.at(-1)!.key });
  }
  const refs = await store.putParts(parts),
    manifest: SelectionPackets = {
      format: "selected-pairs-v3",
      documents: selection.documents,
      vocabulary: selection.terms.length,
      terms: refs[0],
      chunks: ranges.map((r, i) => ({ ...r, ref: refs[i + 1] })),
    };
  return store.put(jsonBytes(manifest), "plan-0.bin");
}
export async function readSelection(
  store: BuildStore,
  ref: Chunk,
  range?: { firstKey: number; endKey: number },
) {
  const manifest: SelectionPackets = JSON.parse(
    new TextDecoder().decode(await store.get(ref)),
  );
  if (
    manifest.format !== "selected-pairs-v3" ||
    manifest.vocabulary < 1 ||
    manifest.vocabulary > 65536 ||
    manifest.terms.size !== manifest.vocabulary * 4
  )
    throw Error("Invalid pair selection manifest");
  const selected = manifest.chunks.filter(
      (c) => !range || (c.last >= range.firstKey && c.first < range.endKey),
    ),
    packets = await store.getMany(
      selected.map((c) => c.ref),
      4 * 1048576,
    ),
    pairs: PairSelection["pairs"] = [];
  for (let b = 0; b < packets.length; b++) {
    const raw = packets[b],
      v = view(raw);
    if (!raw.length || raw.length % 32)
      throw Error("Invalid pair descriptor packet");
    for (let p = 0; p < raw.length; p += 32) {
      const key = v.getUint32(p, true),
        df = v.getUint32(p + 12, true),
        occurrences = v.getFloat64(p + 16, true),
        cost = v.getFloat64(p + 24, true);
      if (
        (p && key <= v.getUint32(p - 32, true)) ||
        !df ||
        df > manifest.documents ||
        !Number.isSafeInteger(occurrences) ||
        occurrences < df ||
        !Number.isSafeInteger(cost) ||
        cost < 1
      )
        throw Error("Invalid selected pair statistics");
      if (
        (p === 0 && key !== selected[b].first) ||
        (p + 32 === raw.length && key !== selected[b].last)
      )
        throw Error("Pair descriptor fence mismatch");
      if (!range || (key >= range.firstKey && key < range.endKey))
        pairs.push({
          key,
          a: v.getUint32(p + 4, true),
          b: v.getUint32(p + 8, true),
          df,
          occurrences,
          cost,
        });
    }
  }
  return { manifest, pairs };
}
export async function occurrenceSelection(
  store: BuildStore,
  ref: Chunk,
): Promise<PairSelection> {
  const { manifest, pairs } = await readSelection(store, ref),
    raw = await store.get(manifest.terms),
    v = view(raw);
  return {
    documents: manifest.documents,
    terms: Array.from({ length: manifest.vocabulary }, (_, i) => ({
      id: v.getUint32(i * 4, true),
    })),
    pairs,
  };
}
