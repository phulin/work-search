import { concat, u32, view } from "./format.js";
import {
  PairMembershipPacket,
  encodePairMembershipPacket,
  type PairMembership,
} from "./pair-membership.js";
import type { PairPacket } from "./pair-packet.js";
import type { ExactPairRanges } from "./pair-ranges.js";
export type { ExactPairRanges } from "./pair-ranges.js";
export { completePairRanges } from "./pair-ranges.js";

export interface ExactPairDescriptor {
  a: string;
  b: string;
  df: number;
  bodyDf: number;
  titleDf: number;
  bodyOccurrences: number;
  titleOccurrences: number;
  directory: ExactPairRanges;
  inline?: PairPacket;
  /** Query-local view of an already fetched sorted membership record. */
  membership?: PairMembership;
}
export interface ExactPhraseMetadata {
  generation: string;
  baseGeneration: string;
  documents: number;
  objects: { id: number; bytes: number; sha256: string }[];
}
/** Bundled complete-coverage descriptors. Existing membership objects remain
 * immutable; the independent positional generation is bound to the corpus. */
export function encodeExactPhraseDirectory(
  metadata: ExactPhraseMetadata,
  pairs: ExactPairDescriptor[],
) {
  const json = new TextEncoder().encode(JSON.stringify(metadata));
  return concat([
    u32([0x32445045, json.length]),
    json,
    encodePairMembershipPacket(
      pairs.map((p) => ({
        a: p.a,
        b: p.b,
        data: concat([
          u32([
            p.df,
            p.bodyDf,
            p.titleDf,
            p.bodyOccurrences,
            p.titleOccurrences,
            p.directory.a,
            p.directory.b,
          ]),
          u32(
            p.directory.ranges.flatMap((r) => [r.object, r.offset, r.length]),
          ),
        ]),
      })),
    ),
  ]);
}
export class ExactPhraseDirectory {
  readonly metadata: ExactPhraseMetadata;
  private packet: PairMembershipPacket;
  constructor(readonly bytes: Uint8Array) {
    const v = view(bytes);
    if (bytes.length < 8 || v.getUint32(0, true) !== 0x32445045)
      throw Error("Invalid exact phrase directory");
    const end = 8 + v.getUint32(4, true);
    this.metadata = JSON.parse(
      new TextDecoder().decode(bytes.subarray(8, end)),
    );
    if (
      ![this.metadata.generation, this.metadata.baseGeneration].every((s) =>
        /^[a-f0-9]{64}$/.test(s),
      )
    )
      throw Error("Invalid exact phrase generation");
    this.packet = new PairMembershipPacket(bytes.subarray(end));
  }
  lookup(a: string, b: string): ExactPairDescriptor | undefined {
    const raw = this.packet.record(a, b);
    if (!raw) return;
    if (raw.length < 40 || (raw.length - 28) % 12)
      throw Error("Invalid complete phrase extents");
    const v = view(raw),
      ranges: ExactPairRanges["ranges"] = [];
    for (let at = 28; at < raw.length; at += 12) {
      const r = {
        object: v.getUint32(at, true),
        offset: v.getUint32(at + 4, true),
        length: v.getUint32(at + 8, true),
      };
      if (!r.length || r.offset + r.length > 32 * 1048576)
        throw Error("Invalid phrase extent");
      ranges.push(r);
    }
    const directory = {
      a: v.getUint32(20, true),
      b: v.getUint32(24, true),
      generation: this.metadata.generation,
      ranges,
    };
    return {
      a,
      b,
      df: v.getUint32(0, true),
      bodyDf: v.getUint32(4, true),
      titleDf: v.getUint32(8, true),
      bodyOccurrences: v.getUint32(12, true),
      titleOccurrences: v.getUint32(16, true),
      directory,
    };
  }
}
