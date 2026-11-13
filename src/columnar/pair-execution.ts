import { PairPacket, intersectPairDocuments } from "./pair-packet.js";
import {
  pairKey,
  pairPhraseEvidence,
  pairPhraseCovered,
} from "./pair-evidence.js";
import type { PositionalPair } from "./format.js";
import type { Reader } from "./storage.js";

/** The same exact pair evidence leads candidate packages or limits block ranges.
 * An uncovered context stays unknown and requires ordinary positional matching. */
export async function readPairAnchor(
  descriptors: PositionalPair[],
  words: string[],
  ids: Map<string, number>,
  field: "all" | "body" | "title",
  reader: Reader,
) {
  const raw = await reader.packets(descriptors.map((p) => p.ref)),
    packets = raw.map((bytes, i) => {
      const d = descriptors[i],
        key = "pair:" + reader.key(d.ref),
        seen = reader.pairDecoded.get(key) ?? new Uint8Array(d.df * 2),
        p = new PairPacket(bytes, (row, field, count, n) => {
          reader.stats.positionIntegers += count;
          reader.stats.pairContextIntegers += count * 2;
          reader.stats.decodedBytes += n;
          const section = row * 2 + field;
          if (seen[section]) reader.stats.repeatedDecodedBytes += n;
          seen[section] = 1;
        });
      if (p.a !== d.a || p.b !== d.b || p.docs.length !== d.df)
        throw Error("Pair descriptor mismatch");
      reader.pairDecoded.set(key, seen);
      reader.stats.postings += p.docs.length;
      return p;
    }),
    map = new Map(packets.map((p) => [pairKey(p.a, p.b), p])),
    evidence = pairPhraseEvidence(map, ids),
    all = intersectPairDocuments(packets, field),
    accepted = new Uint32Array(all.length),
    fields = field === "all" ? [0, 1] : [field === "body" ? 0 : 1];
  let count = 0;
  for (const doc of all)
    if (
      fields.some((f) => {
        const exact = evidence(words, doc, f);
        return exact === undefined || exact.length > 0;
      })
    )
      accepted[count++] = doc;
  return {
    candidates: accepted.subarray(0, count),
    evidence,
    covered: (words: string[]) => pairPhraseCovered(map, ids, words),
  };
}
