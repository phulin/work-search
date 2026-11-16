import type { Node } from "../query/parser.js";
import type { Reader } from "./storage.js";
import { lower } from "./format.js";
import {
  pairPositionReads,
  readPairPositionChunks,
  type PairEvidence,
} from "./pair-positions.js";
import {
  mandatoryPhrases,
  pairKey,
  pairPhraseCovered,
  pairPhraseEvidence,
} from "./pair-evidence.js";
import { PairMembershipPacket, PairMembership } from "./pair-membership.js";
import { PairRouter, pairObjectKey } from "./pair-router.js";
import type { PairPacket } from "./pair-packet.js";
import {
  advanceCursor,
  intersectCursors,
  unionCursors,
} from "./numeric-cursor.js";
import { candidatePairContext } from "./candidate-pair-context.js";

export interface MembershipSettings {
  exactPhrases?: import("./exact-phrase-directory.js").ExactPhraseDirectory;
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
  anchors?: string[];
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
export function savedWork(
  alternative: FilterAlternative,
  candidates: number,
  documents: number,
  documentBytes: number,
  exactTotal: boolean,
) {
  const before = alternative.expectedCandidates,
    after = Math.min(before, candidates);
  if (!before) return 0;
  if (alternative.kind === "documents")
    // Numeric-only records reduce bytes, but each candidate still occupies a
    // request slot. Charge a conservative page-equivalent per six-read wave;
    // otherwise cheaper records can perversely suppress a useful pair read
    // and push the unfiltered continuation into a broad postings fallback.
    return (
      (before - after) * documentBytes +
      Math.max(0, Math.ceil(before / 6) - Math.ceil(after / 6)) * 262144
    );
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
  bufferBytes?: number;
  values(): Generator<number>;
  has(doc: number): boolean;
  cursor(): { next(): number };
  evidence: ReturnType<typeof pairPhraseEvidence>;
  covered: (words: string[]) => boolean;
}
/** Restrict conservative pair evidence by independently necessary unigrams.
 * Preserve phrase/context evidence while sharing one sorted numeric result
 * across pricing, document verification and block fallback. */
export function intersectMembershipAnchor(
  anchor: MembershipAnchor,
  ids?: Uint32Array,
): MembershipAnchor {
  if (!ids) return anchor;
  const docs = new Uint32Array(Math.min(ids.length, anchor.count));
  let at = 0,
    count = 0;
  const source = anchor.cursor();
  for (
    let doc = source.next();
    doc !== Infinity && at < ids.length;
    doc = source.next()
  ) {
    while (at < ids.length && ids[at] < doc) at++;
    if (ids[at] === doc) docs[count++] = doc;
  }
  const selected = docs.subarray(0, count);
  return {
    ...anchor,
    bufferBytes: (anchor.bufferBytes ?? 0) + docs.buffer.byteLength,
    count,
    values: function* () {
      yield* selected;
    },
    has: (doc) => selected[lower(selected, doc)] === doc,
    cursor: () => {
      let row = 0;
      return { next: () => (row < count ? selected[row++] : Infinity) };
    },
  };
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
    // N/M describe preferred anchors, not eligibility. In particular a phrase
    // containing an ordinary word can still have only top-M adjacent pairs.
    // Price those pairs against the alternative instead of rejecting them.
    const unique = all
      .filter((p, i) => all.findIndex((q) => p.a === q.a && p.b === q.b) === i)
      .sort(
        (a, b) =>
          a.df - b.df ||
          a.bytes - b.bytes ||
          Number(a.excluded) - Number(b.excluded) ||
          a.at - b.at,
      );
    if (!unique.length) continue;
    const estimate = (pairs: typeof unique): PairReadPlan => {
      const primary = pairs.length > 1 ? estimate([pairs[0]]) : undefined;
      let count = pairs[0].df;
      for (const p of pairs.slice(1)) {
        const lead = pairs[0],
          shared = [lead.a, lead.b].find((w) => w === p.a || w === p.b),
          denominator = shared
            ? (wordStats?.get(shared)?.df ?? documents)
            : documents;
        // Preserve useful supplementary filters on an already profitable
        // anchor. Otherwise do not manufacture a profitable top-M combination
        // from independence across a ubiquitous connector ("burden of" /
        // "of proving"). Common pairs remain eligible on their own.
        count =
          shared &&
          (lead.excluded || p.excluded) &&
          denominator > documents / 2 &&
          primary!.savedWork <= primary!.readWork
            ? Math.min(count, p.df)
            : Math.min(
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
      // Pair DF is corpus-wide. A document plan has already intersected its
      // unigram anchors: estimate the pair's incremental selectivity there,
      // conditioning on a shared anchor when available. This affects cost only;
      // actual memberships, never this estimate, restrict execution.
      const sharedDf = Math.min(
        ...words
          .filter((w) => alternative?.anchors?.includes(w))
          .map((w) => wordStats?.get(w)?.df ?? documents),
      );
      const filtered =
        alternative?.kind === "documents"
          ? Math.min(
              count,
              Math.ceil(
                (alternative.expectedCandidates * count) /
                  Math.max(1, Number.isFinite(sharedDf) ? sharedDf : documents),
              ),
            )
          : count;
      const gain = alternative
        ? savedWork(
            alternative,
            filtered,
            documents,
            candidateBytes,
            exactTotal,
          )
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
    if (
      (record.positionDirectory &&
        record.positionDirectory.generation !== router.metadata.generation) ||
      (record.completePositions &&
        record.completePositions.generation !== router.metadata.generation)
    )
      throw Error("Pair position generation mismatch");
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
  const packets = new Map<string, PairEvidence>();
  for (const record of selection.records)
    if (record.supplementalContext ?? record.context)
      packets.set(
        pairKey(record.a, record.b),
        (record.supplementalContext ?? record.context)!,
      );
  const evidence = pairPhraseEvidence(packets, ids),
    covered = (words: string[]) => pairPhraseCovered(packets, ids, words),
    records = [...selection.records].sort((a, b) => a.df - b.df),
    direct =
      !selection.absent &&
      records.length === 1 &&
      !records[0].context &&
      !records[0].supplementalContext
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
      const accept = (doc: number) => {
        for (; doc !== Infinity; doc = base.next()) {
          const exact = evidence(selection.words, doc, f);
          if (exact === undefined || exact.length) return doc;
        }
        return Infinity;
      };
      return {
        next: () => accept(base.next()),
        advance: (target: number) => accept(advanceCursor(base, target)),
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
  let count = direct
    ? field === "all"
      ? direct.df
      : direct[field].count
    : undefined;
  return {
    get count() {
      if (count === undefined) {
        count = 0;
        const c = cursor();
        while (c.next() !== Infinity) count++;
      }
      return count;
    },
    values,
    has,
    cursor,
    evidence,
    covered,
  };
}

/** Price all required chunks before I/O. An unselected product is unknown. */
export async function enrichMembershipPositions(
  selection: MembershipSelection,
  docs: Uint32Array,
  reader: Reader,
  budget: number,
  completeStreams = false,
  maxReadMs = Infinity,
  ids?: Map<string, number>,
) {
  const available = new Set<string>();
  for (const r of selection.records)
    if (r.context || r.supplementalContext) available.add(pairKey(r.a, r.b));
  if (ids && pairPhraseCovered(available, ids, selection.words)) return false;
  // Complete streams have no per-document fences. Price their bounded GETs
  // against opening candidate records, then retain only relevant occurrences.
  // This is an optional necessary-condition refinement, never a cutoff.
  const complete = selection.records
    .filter(
      (r) =>
        completeStreams &&
        selection.words.length > 2 &&
        r.completePositions &&
        !r.supplementalContext,
    )
    .map((record) => {
      const ranges = record.completePositions!.ranges,
        bytes = ranges.reduce((n, r) => n + r.length, 0),
        gets = ranges.reduce((n, r) => n + Math.ceil(r.length / 262144), 0),
        cost = bytes / 104857.6 + Math.ceil(gets / 6) * 20 + record.df / 50000;
      return { record, cost };
    })
    .sort((a, b) => a.cost - b.cost);
  const best = complete[0];
  if (
    best &&
    best.cost < maxReadMs &&
    best.cost < Math.ceil(docs.length / 6) * 20 * 0.5
  ) {
    best.record.supplementalContext = await candidatePairContext(
      best.record.completePositions!,
      docs,
      reader,
      budget,
    );
    if (best.record.supplementalContext) {
      maxReadMs -= best.cost;
      available.add(pairKey(best.record.a, best.record.b));
      if (ids && pairPhraseCovered(available, ids, selection.words))
        return true;
    }
  }
  const choices = selection.records
    .filter((r) => r.positionDirectory && !r.supplementalContext)
    .map((record) => {
      const chunks = record.positionDirectory!.selected(docs),
        reads = pairPositionReads(chunks),
        bytes = chunks.reduce((n, c) => n + c.length, 0),
        cost =
          reads.reduce((n, r) => n + r.length, 0) / 104857.6 +
          Math.ceil(reads.length / 6) * 20,
        covering =
          !!ids &&
          selection.words
            .slice(1)
            .some(
              (b, at) =>
                ids.get(selection.words[at]) === record.a &&
                ids.get(b) === record.b &&
                at <= 1 &&
                selection.words.length - at - 2 <= 1,
            );
      return { record, bytes, cost, covering };
    })
    .sort((a, b) => Number(b.covering) - Number(a.covering) || a.cost - b.cost);
  let remaining = budget;
  const selected = choices.filter((c) => {
    if (c.bytes > remaining) return false;
    if (c.cost > maxReadMs) {
      reader.stats.pairPositionProductsSkipped++;
      return false;
    }
    if (ids && pairPhraseCovered(available, ids, selection.words)) return false;
    remaining -= c.bytes;
    maxReadMs -= c.cost;
    available.add(pairKey(c.record.a, c.record.b));
    return true;
  });
  await Promise.all(
    selected.map(async ({ record, bytes }) => {
      const directory = record.positionDirectory!;
      record.supplementalContext = await readPairPositionChunks(
        directory,
        docs,
        (key, n) => {
          reader.stats.pairPositionChunks++;
          reader.stats.pairPositionBytes += n;
          reader.stats.anchorBufferBytes += n;
          return reader.named(key, n);
        },
        bytes,
        (_row, _field, n, decoded) => {
          reader.stats.positionIntegers += n;
          reader.stats.pairContextIntegers += 2 * n;
          reader.stats.decodedBytes += decoded;
          reader.stats.anchorBufferBytes += decoded;
        },
      );
    }),
  );
  return (
    !!best?.record.supplementalContext ||
    selected.some((c) => !!c.record.supplementalContext)
  );
}
