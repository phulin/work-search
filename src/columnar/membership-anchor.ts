import type { Node } from "../query/parser.js";
import type { Reader } from "./storage.js";
import {
  mandatoryPhrases,
  pairKey,
  pairPhraseCovered,
  pairPhraseEvidence,
} from "./pair-evidence.js";
import { PairMembershipPacket, PairMembership } from "./pair-membership.js";
import { PairRouter, pairObjectKey } from "./pair-router.js";
import type { PairPacket } from "./pair-packet.js";
import { intersectCursors, unionCursors } from "./numeric-cursor.js";

export interface MembershipSettings {
  router: PairRouter;
  N: number;
  M: number;
  presence?: {
    generation: string;
    entries: { bytes: number; crc32: number }[];
  };
}
export interface FilterAlternative {
  kind: "complete-terms" | "documents" | "blocks";
  frequencyBytes: number;
  positionBytes: number;
  expectedCandidates: number;
}
export interface PairReadPlan {
  words: string[];
  pairs: { a: string; b: string; df: number; bytes: number }[];
  absent: boolean;
  expectedCandidates: number;
  readWork: number;
  savedWork: number;
}
const cellCoverage = (count: number, documents: number) =>
  -Math.expm1((-128 * count) / documents);
/** Work estimates select reads; they never reject a matching document. */
function savedWork(
  alternative: FilterAlternative,
  candidates: number,
  documents: number,
  documentBytes: number,
  exactTotal: boolean,
) {
  const before = alternative.expectedCandidates,
    after = Math.min(before, candidates);
  if (!before) return 0;
  if (alternative.kind === "documents") return (before - after) * documentBytes;
  if (alternative.kind === "complete-terms") return 0;
  return (
    alternative.frequencyBytes *
      Math.max(
        0,
        cellCoverage(before, documents) - cellCoverage(after, documents),
      ) +
    alternative.positionBytes *
      (exactTotal ? 1 : 1 / 128) *
      (1 - after / before)
  );
}
export function commonWordExclusions(settings: MembershipSettings) {
  return new Set(
    settings.router.metadata.commonWords
      .slice(0, settings.N)
      .map((w) => w.word),
  );
}
/** All dictionary/presence decisions are made locally before any optional I/O. */
export function planCommonPresence(
  required: Set<string>,
  settings: MembershipSettings,
  proved: ReadonlySet<string>,
  alternative: FilterAlternative | undefined,
  documentBytes: number,
  exactTotal: boolean,
) {
  if (
    !settings.presence ||
    !alternative ||
    alternative.kind === "complete-terms"
  )
    return [];
  const excluded = commonWordExclusions(settings);
  if (required.size < 2 || ![...required].some((w) => !excluded.has(w)))
    return [];
  return settings.router.metadata.commonWords
    .slice(0, settings.N)
    .map((word, rank) => ({ ...word, rank }))
    .filter((w) => required.has(w.word) && !proved.has(w.word))
    .map((w) => {
      const bytes = settings.presence!.entries[w.rank]?.bytes ?? Infinity,
        candidates =
          (alternative.expectedCandidates * w.df) /
          settings.router.metadata.documents,
        decode = Math.min(w.df, alternative.expectedCandidates * 128) * 4,
        gain =
          savedWork(
            alternative,
            candidates,
            settings.router.metadata.documents,
            documentBytes,
            exactTotal,
          ) -
          bytes -
          decode -
          262144;
      return { ...w, gain };
    })
    .filter((w) => w.gain > 0)
    .sort((a, b) => b.gain - a.gain)
    .slice(0, 2)
    .map((w) => w.rank);
}
export async function loadCommonPresence(
  ranks: readonly number[],
  reader: Reader,
  settings: MembershipSettings,
) {
  const presence = settings.presence;
  if (!presence || !ranks.length) return [];
  if (presence.generation !== settings.router.metadata.generation)
    throw Error("Common presence generation mismatch");
  return Promise.all(
    ranks.map(async (rank) => {
      const word = settings.router.metadata.commonWords[rank],
        entry = presence.entries[rank];
      if (!word || !entry) throw Error("Missing common presence locator");
      const raw = await reader.named(
          `${presence.generation}/presence-${rank}.bin`,
          entry.bytes,
        ),
        record = new PairMembership(
          raw,
          settings.router.metadata.documents,
          undefined,
          (_field, _block, n, bytes) => {
            reader.stats.commonPresenceIntegers += n;
            reader.stats.commonPresenceDecodedBytes += bytes;
            reader.stats.decodedBytes += bytes;
          },
        );
      if (record.a !== word.id || record.b !== word.id || record.df !== word.df)
        throw Error("Common presence identity mismatch");
      return record;
    }),
  );
}
export interface MembershipSelection {
  words: string[];
  records: PairMembership[];
  absent: boolean;
}
export interface MembershipAnchor {
  count: number;
  values(): Generator<number>;
  has(doc: number): boolean;
  cursor(): { next(): number };
  evidence: ReturnType<typeof pairPhraseEvidence>;
  covered: (words: string[]) => boolean;
}
export function planMembershipAnchor(
  ast: Node,
  settings: MembershipSettings,
  wordStats?: ReadonlyMap<string, { df: number }>,
  candidateBytes = 16384,
  field: "all" | "body" | "title" = "all",
  alternative?: FilterAlternative,
  exactTotal = false,
): PairReadPlan | undefined {
  const { router, M } = settings,
    documents = router.metadata.documents,
    excluded = commonWordExclusions(settings),
    choices: PairReadPlan[] = [];
  for (const words of mandatoryPhrases(ast).values()) {
    const all = words.slice(1).map((b, at) => {
      const a = words[at],
        stats = router.statistics(a, b),
        leaf = router.route(a, b),
        wordDf = Math.min(
          wordStats?.get(a)?.df ?? documents,
          wordStats?.get(b)?.df ?? documents,
        );
      return {
        a,
        b,
        at,
        stats,
        leaf,
        df: stats
          ? field === "body"
            ? stats.bodyDf
            : field === "title"
              ? stats.titleDf
              : stats.df
          : Math.max(
              1,
              Math.ceil(Math.min(router.unknownDfEstimate(), wordDf / 2)),
            ),
        bytes: leaf?.bytes ?? 0,
        excluded: stats !== undefined && stats.rank >= 0 && stats.rank < M,
      };
    });
    if (all.some((p) => !p.leaf || (p.stats && p.df === 0)))
      return {
        words,
        pairs: [],
        absent: true,
        expectedCandidates: 0,
        readWork: 0,
        savedWork: Infinity,
      };
    // Cold metadata is fetched in the same initial wave. Avoid speculating on
    // optional filters until a comparable bundled alternative is available.
    if (!alternative && wordStats) continue;
    const ordinary = all.filter((p) => !p.excluded),
      usable = ordinary.length
        ? ordinary
        : words.every((w) => excluded.has(w))
          ? all
          : [];
    const unique = usable
      .filter(
        (p, i) => usable.findIndex((q) => p.a === q.a && p.b === q.b) === i,
      )
      .sort((a, b) => a.df - b.df || a.bytes - b.bytes || a.at - b.at);
    if (!unique.length) continue;
    const estimate = (pairs: typeof unique) => {
      let count = pairs[0].df;
      for (const p of pairs.slice(1)) {
        const lead = pairs[0],
          shared = [lead.a, lead.b].find((w) => w === p.a || w === p.b),
          denominator = shared
            ? (wordStats?.get(shared)?.df ?? documents)
            : documents;
        count = Math.min(
          count,
          p.df,
          Math.ceil((count * p.df) / Math.max(1, denominator)),
        );
      }
      const requests = new Map(
        pairs.map((p) => [
          pairObjectKey(router.metadata.generation, p.leaf!),
          p.bytes,
        ]),
      );
      const readWork =
        [...requests.values()].reduce((n, b) => n + b, 0) +
        pairs.reduce((n, p) => n + p.df * 4, 0) +
        1048576;
      const gain = alternative
        ? savedWork(alternative, count, documents, candidateBytes, exactTotal)
        : Infinity;
      return {
        words,
        pairs,
        absent: false,
        expectedCandidates: count,
        readWork,
        savedWork: gain,
      };
    };
    let choice = estimate(unique.slice(0, 1));
    // Evaluate ordinary pair intersections together, before starting either GET.
    for (const second of unique.slice(1)) {
      const next = estimate([unique[0], second]);
      if (
        next.savedWork - next.readWork > choice.savedWork - choice.readWork ||
        !alternative
      )
        choice = next;
    }
    if (alternative && choice.savedWork <= choice.readWork) continue;
    // An excluded pair may filter a worthwhile ordinary anchor, without
    // becoming the primary candidate generator itself.
    if (choice.pairs.length === 1 && ordinary.length) {
      for (const second of all.filter((p) => p.excluded)) {
        const next = estimate([unique[0], second]);
        if (next.savedWork - next.readWork > choice.savedWork - choice.readWork)
          choice = next;
      }
    }
    choices.push(choice);
  }
  return choices.sort(
    (a, b) =>
      b.savedWork - b.readWork - (a.savedWork - a.readWork) ||
      a.expectedCandidates - b.expectedCandidates,
  )[0];
}
export async function lookupMembershipAnchor(
  ast: Node,
  reader: Reader,
  settings: MembershipSettings,
  wordStats?: ReadonlyMap<string, { df: number }>,
  candidateBytes = 16384,
  field: "all" | "body" | "title" = "all",
) {
  const plan = planMembershipAnchor(
    ast,
    settings,
    wordStats,
    candidateBytes,
    field,
  );
  return plan ? readMembershipAnchor(plan, reader, settings) : undefined;
}
export async function readMembershipAnchor(
  choice: PairReadPlan,
  reader: Reader,
  settings: MembershipSettings,
): Promise<MembershipSelection> {
  const { router } = settings;
  if (choice.absent) return { words: choice.words, records: [], absent: true };
  const requests = new Map<string, Promise<PairMembershipPacket>>();
  for (const pair of choice.pairs) {
    const leaf = router.route(pair.a, pair.b);
    if (!leaf) return { words: choice.words, records: [], absent: true };
    const key = pairObjectKey(router.metadata.generation, leaf);
    if (!requests.has(key)) {
      reader.stats.pairDirectoryBytes += leaf.bytes;
      requests.set(
        key,
        reader
          .named(key, leaf.bytes)
          .then((raw) => new PairMembershipPacket(raw)),
      );
    }
  }
  const packets = new Map(
      await Promise.all(
        [...requests].map(
          async ([key, promise]) => [key, await promise] as const,
        ),
      ),
    ),
    records: PairMembership[] = [];
  reader.stats.stages++;
  reader.stats.pairDirectoryRanges += requests.size;
  for (const pair of choice.pairs) {
    const leaf = router.route(pair.a, pair.b)!,
      packet = packets.get(pairObjectKey(router.metadata.generation, leaf))!,
      seen = new Set<number>(),
      membershipSeen = [
        new Uint8Array(Math.ceil(router.metadata.documents / 128)),
        new Uint8Array(Math.ceil(router.metadata.documents / 128)),
      ],
      record = packet.lookup(
        pair.a,
        pair.b,
        router.metadata.documents,
        (row, field, occurrences, bytes) => {
          reader.stats.positionIntegers += occurrences;
          reader.stats.pairContextIntegers += occurrences * 2;
          reader.stats.decodedBytes += bytes;
          const section = row * 2 + field;
          if (seen.has(section)) reader.stats.repeatedDecodedBytes += bytes;
          seen.add(section);
        },
        (field, block, n, bytes) => {
          reader.stats.pairMembershipIntegers += n;
          reader.stats.postings += n;
          reader.stats.decodedBytes += bytes;
          reader.stats.pairMembershipDecodedBytes += bytes;
          if (membershipSeen[field][block]) {
            reader.stats.repeatedDecodedBytes += bytes;
            reader.stats.pairMembershipRepeatedDecodedBytes += bytes;
          }
          membershipSeen[field][block] = 1;
        },
      );
    if (!record) return { words: choice.words, records: [], absent: true };
    records.push(record);
    reader.stats.pairDirectoryMatches++;
  }
  return { words: choice.words, records, absent: false };
}
export function membershipAnchor(
  selection: MembershipSelection,
  ids: Map<string, number>,
  field: "all" | "body" | "title",
): MembershipAnchor {
  const packets = new Map<string, PairPacket>();
  for (const record of selection.records)
    if (record.context)
      packets.set(pairKey(record.a, record.b), record.context);
  const evidence = pairPhraseEvidence(packets, ids),
    covered = (words: string[]) => pairPhraseCovered(packets, ids, words),
    records = [...selection.records].sort((a, b) => a.df - b.df),
    direct =
      !selection.absent && records.length === 1 && !records[0].context
        ? records[0]
        : undefined;
  const has = (doc: number) => {
    if (selection.absent) return false;
    if (direct) return direct.has(doc, field);
    for (
      let f = field === "title" ? 1 : 0;
      f <= (field === "body" ? 0 : 1);
      f++
    ) {
      let present = true;
      for (let i = 0; i < records.length; i++)
        if (!(f ? records[i].title : records[i].body).has(doc)) {
          present = false;
          break;
        }
      if (!present) continue;
      const exact = evidence(selection.words, doc, f);
      if (exact === undefined || exact.length > 0) return true;
    }
    return false;
  };
  function cursor() {
    if (direct) return direct.cursor(field);
    if (selection.absent || !records.length) return { next: () => Infinity };
    const perField = (f: 0 | 1) => {
      const base = intersectCursors(
        records.map((r) => (f ? r.title : r.body).cursor()),
      );
      if (!packets.size) return base;
      return {
        next: () => {
          for (let doc = base.next(); doc !== Infinity; doc = base.next()) {
            const exact = evidence(selection.words, doc, f);
            if (exact === undefined || exact.length) return doc;
          }
          return Infinity;
        },
      };
    };
    return field === "body"
      ? perField(0)
      : field === "title"
        ? perField(1)
        : unionCursors(perField(0), perField(1));
  }
  function* values() {
    const c = cursor();
    for (let doc = c.next(); doc !== Infinity; doc = c.next()) yield doc;
  }
  let count = direct ? (field === "all" ? direct.df : direct[field].count) : 0;
  if (!direct) {
    const c = cursor();
    while (c.next() !== Infinity) count++;
  }
  return { count, values, has, cursor, evidence, covered };
}
