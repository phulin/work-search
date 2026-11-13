import { concat, u32, view } from "./format.js";
import {
  pairHash,
  pairStringHash,
  PairMembershipPacket,
} from "./pair-membership.js";
export const NO_PAIR_PARTITION = -2147483648;
export interface PairRoutingMetadata {
  generation: string;
  baseGeneration: string;
  documents: number;
  targetBytes: number;
  contextBytes: number;
  namespaces: string[];
  roots: number[];
  commonWords: { word: string; id: number; df: number }[];
}
export interface PairLeaf {
  namespace: number;
  bits: number;
  prefix: number;
  suffix?: number;
  bytes: number;
  crc32: number;
  pairs: number;
}
export function pairObjectKey(
  generation: string,
  leaf: Pick<PairLeaf, "namespace" | "bits" | "prefix" | "suffix">,
) {
  return `${generation}/pairs-${leaf.namespace}-${leaf.bits}-${leaf.prefix.toString(16)}-${(leaf.suffix ?? 0).toString(16)}.bin`;
}
export function encodePairRouter(
  metadata: PairRoutingMetadata,
  nodes: [number, number][],
  leaves: PairLeaf[],
  common: Uint8Array,
) {
  const json = new TextEncoder().encode(JSON.stringify(metadata)),
    header = u32([
      0x31525043,
      json.length,
      nodes.length,
      leaves.length,
      common.length,
    ]),
    tree = new Uint8Array(nodes.length * 8),
    table = new Uint8Array(leaves.length * 28),
    tv = view(tree),
    lv = view(table);
  nodes.forEach((node, i) =>
    node.forEach((n, j) => tv.setInt32(i * 8 + j * 4, n, true)),
  );
  leaves.forEach((leaf, i) =>
    [
      leaf.namespace,
      leaf.bits,
      leaf.prefix,
      leaf.bytes,
      leaf.crc32,
      leaf.pairs,
      leaf.suffix ?? 0,
    ].forEach((n, j) => lv.setUint32(i * 28 + j * 4, n, true)),
  );
  return concat([header, json, tree, table, common]);
}
/** A binary prefix trie routes directly to an authoritative self-contained
 * object. No term-ID discovery, per-pair address map or remote routing read. */
export class PairRouter {
  readonly metadata: PairRoutingMetadata;
  private nodes: DataView;
  private leaves: DataView;
  private common: PairMembershipPacket;
  private namespaces: Map<string, number>;
  private tailDf?: number;
  constructor(readonly bytes: Uint8Array) {
    const v = view(bytes);
    if (bytes.length < 20 || v.getUint32(0, true) !== 0x31525043)
      throw Error("Invalid pair router");
    const j = v.getUint32(4, true),
      n = v.getUint32(8, true),
      l = v.getUint32(12, true),
      c = v.getUint32(16, true),
      at = 20 + j;
    if (at + n * 8 + l * 28 + c !== bytes.length)
      throw Error("Invalid pair router spans");
    this.metadata = JSON.parse(
      new TextDecoder().decode(bytes.subarray(20, at)),
    );
    if (this.metadata.roots.length !== this.metadata.namespaces.length + 1)
      throw Error("Invalid pair namespaces");
    this.nodes = view(bytes.subarray(at, at + n * 8));
    this.leaves = view(bytes.subarray(at + n * 8, at + n * 8 + l * 28));
    this.common = new PairMembershipPacket(bytes.subarray(at + n * 8 + l * 28));
    this.namespaces = new Map(
      this.metadata.namespaces.map((s, i) => [s, i + 1]),
    );
  }
  route(a: string, b: string): PairLeaf | undefined {
    const ns = this.namespaces.get(a) ?? 0,
      h = ns
        ? pairStringHash(b)
        : pairHash(pairStringHash(a), pairStringHash(b)),
      h2 = ns
        ? pairStringHash("!" + b)
        : pairHash(pairStringHash("!" + a), pairStringHash("!" + b));
    let node = this.metadata.roots[ns],
      depth = 0;
    while (node >= 0) {
      if (depth === 64 || node * 8 + 8 > this.nodes.byteLength)
        throw Error("Invalid pair route depth");
      node = this.nodes.getInt32(
        node * 8 +
          (((depth < 32 ? h : h2) >>> (depth < 32 ? 31 - depth : 63 - depth)) &
            1) *
            4,
        true,
      );
      depth++;
    }
    if (node === NO_PAIR_PARTITION) return;
    const at = (-node - 1) * 28;
    if (at + 28 > this.leaves.byteLength)
      throw Error("Invalid pair route leaf");
    const leaf = {
      namespace: this.leaves.getUint32(at, true),
      bits: this.leaves.getUint32(at + 4, true),
      prefix: this.leaves.getUint32(at + 8, true),
      bytes: this.leaves.getUint32(at + 12, true),
      crc32: this.leaves.getUint32(at + 16, true),
      pairs: this.leaves.getUint32(at + 20, true),
      suffix: this.leaves.getUint32(at + 24, true),
    };
    if (
      leaf.namespace !== ns ||
      leaf.bits !== depth ||
      (depth === 0 ? 0 : depth < 32 ? h >>> (32 - depth) : h) !== leaf.prefix ||
      (depth <= 32 ? 0 : depth < 64 ? h2 >>> (64 - depth) : h2) !== leaf.suffix
    )
      throw Error("Pair route identity mismatch");
    return leaf;
  }
  statistics(a: string, b: string) {
    const raw = this.common.record(a, b);
    if (!raw) return;
    const v = view(raw);
    return {
      df: v.getUint32(0, true),
      bodyDf: v.getUint32(4, true),
      titleDf: v.getUint32(8, true),
      bytes: v.getUint32(12, true),
      rank: v.getUint32(16, true) - 1,
    };
  }
  /** Corpus-derived prior for pairs outside the ranked hot table. This is a
   * planning estimate, never a matching or pruning bound. No wire-format change. */
  unknownDfEstimate() {
    if (this.tailDf !== undefined) return this.tailDf;
    const data = view(this.common.bytes);
    let df = this.metadata.documents;
    for (let i = 0; i < this.common.count; i++) {
      const at = data.getUint32(24 + i * 16, true),
        n = data.getUint32(28 + i * 16, true);
      if (n !== 20) throw Error("Invalid bundled pair statistics");
      if (data.getUint32(at + 16, true))
        df = Math.min(df, data.getUint32(at, true));
    }
    return (this.tailDf = df);
  }
  wordRank(word: string) {
    return this.metadata.commonWords.findIndex((w) => w.word === word);
  }
}
