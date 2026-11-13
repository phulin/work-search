import type { Root } from "../src/columnar/format.js";
import { OBJECT_GROUP } from "../src/columnar/construction/finish.js";

/** Native posting jobs own disjoint object-number groups. Their dictionary
 * leaves and every scoring/position descendant stay inside the same group.
 * Packet conversion therefore needs only the groups named by its leaf fences. */
export function packetRootProjector(root: Root) {
  const groups = new Map<number, number[]>();
  root.objects.forEach((_, i) => {
    const group = Math.floor((root.objectIds?.[i] ?? i) / OBJECT_GROUP),
      entries = groups.get(group) ?? [];
    entries.push(i);
    groups.set(group, entries);
  });
  return (fences: Root["dictionaries"]): Root => {
    const selected = new Set(
        fences.map((f) => Math.floor(f.ref[0] / OBJECT_GROUP)),
      ),
      indices = [...selected]
        .sort((a, b) => a - b)
        .flatMap((group) => {
          const entries = groups.get(group);
          if (!entries)
            throw Error("Packet dictionary references absent group");
          return entries;
        });
    return {
      format: root.format,
      generation: root.generation,
      corpusHash: root.corpusHash,
      count: root.count,
      avgBody: root.avgBody,
      avgTitle: root.avgTitle,
      documents: [],
      dictionaries: fences,
      hot: {},
      objects: indices.map((i) => root.objects[i]),
      objectIds: indices.map((i) => root.objectIds?.[i] ?? i),
    };
  };
}
