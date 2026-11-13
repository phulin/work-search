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

export interface MembershipSettings {
  router: PairRouter;
  N: number;
  M: number;
  presence?: {
    generation: string;
    entries: { bytes: number; crc32: number }[];
  };
}
export async function loadCommonPresence(
  required: Set<string>,
  reader: Reader,
  settings: MembershipSettings,
) {
  const presence = settings.presence;
  if (!presence) return [];
  const excluded = commonWordExclusions(settings);
  if (required.size < 2 || ![...required].some((word) => !excluded.has(word)))
    return [];
  if (presence.generation !== settings.router.metadata.generation)
    throw Error("Common presence generation mismatch");
  const selected = settings.router.metadata.commonWords
    .slice(0, settings.N)
    .map((word, rank) => ({ ...word, rank }))
    .filter(
      (word) =>
        required.has(word.word) &&
        word.df < settings.router.metadata.documents * 0.95,
    )
    .sort((a, b) => a.df - b.df)
    .slice(0, 2);
  return Promise.all(
    selected.map(async (word) => {
      const entry = presence.entries[word.rank];
      if (!entry) throw Error("Missing common presence locator");
      const raw = await reader.named(
          `${presence.generation}/presence-${word.rank}.bin`,
          entry.bytes,
          entry.crc32,
        ),
        record = new PairMembership(raw, settings.router.metadata.documents);
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
export function commonWordExclusions(settings: MembershipSettings) {
  return new Set(
    settings.router.metadata.commonWords
      .slice(0, settings.N)
      .map((w) => w.word),
  );
}
/** Select at most two pair packets entirely from bundled information. All pair
 * reads start together; unknown statistics never trigger serial discovery. */
export async function lookupMembershipAnchor(
  ast: Node,
  reader: Reader,
  settings: MembershipSettings,
  wordStats?: ReadonlyMap<string, { df: number }>,
  candidateBytes = 16384,
  field: "all" | "body" | "title" = "all",
): Promise<MembershipSelection | undefined> {
  const { router, N, M } = settings,
    excluded = commonWordExclusions(settings),
    choices: {
      words: string[];
      pairs: {
        a: string;
        b: string;
        df: number;
        known: boolean;
        bytes: number;
        at: number;
      }[];
      cost: number;
    }[] = [];
  for (const words of mandatoryPhrases(ast).values()) {
    // Exclusion affects anchor preference, not authoritative rejection. A
    // mandatory phrase cannot match a field with no occurrence of one pair.
    if (
      words.slice(1).some((b, i) => {
        const stats = router.statistics(words[i], b);
        return (
          stats &&
          (field === "all"
            ? stats.df
            : field === "body"
              ? stats.bodyDf
              : stats.titleDf) === 0
        );
      })
    )
      return { words, records: [], absent: true };
    const all = words.slice(1).map((b, i) => {
      const a = words[i],
        s = router.statistics(a, b);
      return {
        a,
        b,
        at: i,
        df: s?.df ?? Infinity,
        known: !!s,
        bytes: s?.bytes ?? router.metadata.targetBytes,
        excluded: s !== undefined && s.rank >= 0 && s.rank < M,
      };
    });
    const ordinary = all.filter((p) => !p.excluded),
      pairs = ordinary.length
        ? ordinary
        : words.every((w) => excluded.has(w))
          ? all
          : [];
    pairs.sort(
      (a, b) =>
        a.df - b.df ||
        a.bytes - b.bytes ||
        Number(a.known) - Number(b.known) ||
        Math.min(words.length, b.at + 3) -
          Math.max(0, b.at - 1) -
          (Math.min(words.length, a.at + 3) - Math.max(0, a.at - 1)) ||
        a.at - b.at,
    );
    if (!pairs.length) continue;
    const selected = [pairs[0]];
    if (!pairs[0].known || pairs[0].df > 32) {
      const other = pairs
        .filter(
          (p) =>
            p !== pairs[0] &&
            !p.known &&
            (p.a !== pairs[0].a || p.b !== pairs[0].b),
        )
        .sort(
          (a, b) =>
            Math.abs(b.at - pairs[0].at) - Math.abs(a.at - pairs[0].at) ||
            a.at - b.at,
        )[0];
      if (other) selected.push(other);
    }
    if (selected.length === 1 && ordinary.length) {
      const lead = selected[0],
        estimated = Number.isFinite(lead.df)
          ? lead.df
          : Math.min(
              wordStats?.get(lead.a)?.df ?? router.metadata.documents,
              wordStats?.get(lead.b)?.df ?? router.metadata.documents,
            ),
        filter = all
          .filter((p) => p.excluded && p.df < router.metadata.documents * 0.95)
          .sort((a, b) => a.df - b.df || a.bytes - b.bytes)[0];
      if (
        filter &&
        estimated *
          (1 - filter.df / router.metadata.documents) *
          candidateBytes >
          Math.max(router.metadata.targetBytes, filter.bytes) * 4
      )
        selected.push(filter);
    }
    choices.push({
      words,
      pairs: selected,
      cost: pairs[0].known ? pairs[0].df : router.metadata.documents / 8,
    });
  }
  choices.sort((a, b) => a.cost - b.cost);
  const choice = choices[0];
  if (!choice) return;
  if (choice.pairs.some((pair) => !router.route(pair.a, pair.b)))
    return { words: choice.words, records: [], absent: true };
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
          .named(key, leaf.bytes, leaf.crc32)
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
    const base =
      selection.absent || !records.length
        ? undefined
        : records[0].cursor(field);
    return {
      next: () => {
        if (!base) return Infinity;
        for (let doc = base.next(); doc !== Infinity; doc = base.next())
          if (has(doc)) return doc;
        return Infinity;
      },
    };
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
