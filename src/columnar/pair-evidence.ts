import { lower, type Root, type PositionalPair } from "./format.js";
import type { PairPacket } from "./pair-packet.js";
import type { Node } from "../query/parser.js";

const EMPTY = new Uint32Array();
export const pairKey = (a: number, b: number) => `${a}:${b}`;
export function pairPhraseCovered(
  packets: Map<string, PairPacket>,
  ids: Map<string, number>,
  words: string[],
) {
  const covered = new Uint8Array(words.length);
  for (let at = 0; at + 1 < words.length; at++)
    if (
      packets.has(
        pairKey(ids.get(words[at]) ?? -1, ids.get(words[at + 1]) ?? -1),
      )
    )
      covered.fill(1, Math.max(0, at - 1), Math.min(words.length, at + 3));
  return covered.every(Boolean);
}
export function mandatoryPhrases(ast: Node): Map<string, string[]> {
  if (ast.kind === "phrase")
    return new Map([[JSON.stringify(ast.terms), ast.terms]]);
  if (!("left" in ast)) return new Map();
  const a = mandatoryPhrases(ast.left),
    b = mandatoryPhrases(ast.right);
  if (ast.kind === "or") return new Map([...a].filter(([key]) => b.has(key)));
  return ast.kind === "except" ? a : new Map([...a, ...b]);
}
/** Only phrases proved mandatory by the full Boolean AST can lead candidates.
 * All chosen pairs belong to one phrase, so same-field intersection is valid. */
export function planPairAnchor(
  ast: Node,
  ids: Map<string, number>,
  root: Root,
) {
  if (!root.positionalPairs) return;
  const choices: {
    words: string[];
    pairs: PositionalPair[];
    covered: boolean;
    bytes: number;
    df: number;
  }[] = [];
  for (const words of mandatoryPhrases(ast).values()) {
    const pairs: PositionalPair[] = [],
      covered = new Uint8Array(words.length);
    let bytes = 0;
    const occurrences = words
      .slice(1)
      .flatMap((b, i) => {
        const pair =
          root.positionalPairs![
            pairKey(ids.get(words[i]) ?? -1, ids.get(b) ?? -1)
          ];
        return pair ? [{ pair, at: i }] : [];
      })
      .sort((a, b) => a.pair.df - b.pair.df || a.pair.ref[2] - b.pair.ref[2]);
    for (const { pair, at } of occurrences) {
      if (pairs.length === 2 || bytes + pair.ref[2] > 8 * 1048576) continue;
      // Repeated instances of the same pair share one packet but still cover
      // their own phrase offsets during exact evidence evaluation.
      if (!pairs.includes(pair)) {
        pairs.push(pair);
        bytes += pair.ref[2];
      }
      covered.fill(1, Math.max(0, at - 1), Math.min(words.length, at + 3));
    }
    if (pairs.length)
      choices.push({
        words,
        pairs,
        covered: covered.every(Boolean),
        bytes,
        df: Math.min(...pairs.map((p) => p.df)),
      });
  }
  return choices.sort((a, b) => a.df - b.df || a.bytes - b.bytes)[0];
}
/** Exact phrase occurrences from selected pairs and their token context. Missing
 * pairs are unknown. Multiple anchors can jointly cover a longer phrase. */
export function pairPhraseEvidence(
  packets: Map<string, PairPacket>,
  ids: Map<string, number>,
) {
  const compiled = new WeakMap<
    string[],
    {
      words: number[];
      anchors: { packet: PairPacket; at: number }[];
      covered: boolean;
      doc: number;
      fields: (Uint32Array | undefined)[];
      seen: boolean[];
    }
  >();
  return (
    names: string[],
    doc: number,
    field: number,
  ): Uint32Array | undefined => {
    let plan = compiled.get(names);
    if (!plan) {
      const words = names.map((name) => ids.get(name) ?? -1),
        anchors: { packet: PairPacket; at: number }[] = [],
        covered = new Uint8Array(words.length);
      for (let at = 0; at + 1 < words.length; at++) {
        const packet = packets.get(pairKey(words[at], words[at + 1]));
        if (!packet) continue;
        anchors.push({ packet, at });
        covered.fill(1, Math.max(0, at - 1), Math.min(words.length, at + 3));
      }
      anchors.sort((a, b) => a.packet.docs.length - b.packet.docs.length);
      plan = {
        words,
        anchors,
        covered: covered.every(Boolean),
        doc: -1,
        fields: [],
        seen: [],
      };
      compiled.set(names, plan);
    }
    if (!plan.anchors.length) return undefined;
    if (plan.doc !== doc) {
      plan.doc = doc;
      plan.fields = [];
      plan.seen = [];
    }
    if (plan.seen[field]) return plan.fields[field];
    let starts: Uint32Array | undefined;
    for (const { packet, at } of plan.anchors) {
      const row = lower(packet.docs, doc);
      if (packet.docs[row] !== doc || !packet.count(row, field)) {
        starts = EMPTY;
        break;
      }
      const next = packet.phrase(row, field, plan.words, at).starts;
      if (!starts) starts = next;
      else {
        let j = 0,
          n = 0;
        for (let i = 0; i < starts.length; i++) {
          while (j < next.length && next[j] < starts[i]) j++;
          if (next[j] === starts[i]) starts[n++] = starts[i];
        }
        starts = starts.subarray(0, n);
      }
      if (!starts.length) break;
    }
    const exact =
      starts && (!starts.length || plan.covered) ? starts : undefined;
    plan.fields[field] = exact;
    plan.seen[field] = true;
    return exact;
  };
}
