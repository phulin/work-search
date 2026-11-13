import type { Node } from "../query/parser.js";
import type { Root, PairDirectoryShard } from "./format.js";
import type { DirectoryTerm } from "./term-directory.js";
import type { Reader } from "./storage.js";
import type { PacketPlan } from "./packet-execution.js";
import { mandatoryPhrases, pairKey } from "./pair-evidence.js";
import { PairDirectory, pairDirectoryShard } from "./pair-directory.js";
/** Consult remote accelerators only when the initial complete/candidate plan
 * has enough work to amortize discovery. Missing entries remain unknown. */
export async function lookupRemotePairs(
  ast: Node,
  terms: Map<string, DirectoryTerm>,
  root: Root,
  reader: Reader,
  plan: PacketPlan,
) {
  if (
    !root.pairDirectory ||
    (plan.kind !== "blocks" &&
      plan.expectedCandidates <= 16 &&
      plan.frequencyBytes + plan.positionBytes <= 262144)
  )
    return root;
  const requests = new Map<
    string,
    { a: number; b: number; work: number; shard: PairDirectoryShard }
  >();
  for (const words of mandatoryPhrases(ast).values())
    for (let i = 0; i + 1 < words.length; i++) {
      const a = terms.get(words[i]),
        b = terms.get(words[i + 1]);
      if (!a || !b || root.positionalPairs?.[pairKey(a.id, b.id)]) continue;
      const shard = pairDirectoryShard(root.pairDirectory.shards, a.id, b.id);
      if (shard)
        requests.set(pairKey(a.id, b.id), {
          a: a.id,
          b: b.id,
          work: Math.min(
            a.bodyOccurrences + a.titleOccurrences,
            b.bodyOccurrences + b.titleOccurrences,
          ),
          shard,
        });
    }
  const selected = new Map<string, PairDirectoryShard>();
  for (const r of [...requests.values()].sort(
    (a, b) => b.work - a.work || a.a - b.a || a.b - b.b,
  )) {
    const key = reader.key(r.shard.ref);
    if (selected.has(key) || selected.size < 8) selected.set(key, r.shard);
  }
  if (!selected.size) return root;
  const refs = [...selected.values()].map((s) => s.ref),
    raw = await reader.packets(refs),
    directories = new Map(
      refs.map((ref, i) => [
        reader.key(ref),
        reader.decoded(
          ref,
          raw[i],
          (b) => new PairDirectory(b, ref),
          raw[i].length,
        ),
      ]),
    ),
    pairs = Object.create(root.positionalPairs ?? null);
  reader.stats.pairDirectoryRanges += refs.length;
  reader.stats.pairDirectoryBytes += raw.reduce((n, b) => n + b.length, 0);
  for (const r of requests.values()) {
    const pair = directories.get(reader.key(r.shard.ref))?.lookup(r.a, r.b);
    if (pair) {
      pairs[pairKey(r.a, r.b)] = pair;
      reader.stats.pairDirectoryMatches++;
    }
  }
  return { ...root, positionalPairs: pairs };
}
