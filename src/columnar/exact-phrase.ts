import { positionalTerms, type Node } from "../query/parser.js";
import type { DirectoryTerm } from "./term-directory.js";
import type { Reader } from "./storage.js";
import type { FilterAlternative } from "./membership-anchor.js";
import type {
  ExactPhraseDirectory,
  ExactPairDescriptor,
} from "./exact-phrase-directory.js";
import { PairPacket } from "./pair-packet.js";
import { lower, concat, view } from "./format.js";
import { QueryResourceError } from "../query/evaluate.js";
import { PairRouter, pairObjectKey } from "./pair-router.js";
import { PairMembershipPacket } from "./pair-membership.js";

/** Boolean truth needs no occurrence list. Proximity and standalone rendering
 * still require genuine positions; membership is never fabricated into spans. */
function membershipPhrases(ast: Node) {
  const eligible = new Set<string>(),
    spans = new Set<string>();
  const visit = (n: Node, positions: boolean): void => {
    if (n.kind === "phrase" && n.terms.length === 2) {
      (positions ? spans : eligible).add(n.terms.join("\0"));
    } else if (n.kind === "not") visit(n.child, false);
    else if ("left" in n) {
      visit(n.left, positions || n.kind === "near");
      visit(
        n.right,
        n.kind === "except" ? false : positions || n.kind === "near",
      );
    }
  };
  visit(ast, ast.kind === "phrase");
  for (const key of spans) eligible.delete(key);
  return eligible;
}

/** One routed discovery wave. Every record has complete context: tiny records
 * already contain it; larger records directly address their complete stream.
 * Prefer a covering pair whose packet is already required by candidate planning.
 */
export async function readExactPhrasePairs(
  ast: Node,
  router: PairRouter | undefined,
  directory: ExactPhraseDirectory | undefined,
  reader: Reader,
  alternative: FilterAlternative | undefined,
  selected: { a: string; b: string }[] = [],
  terms?: ReadonlyMap<string, DirectoryTerm>,
  options: {
    field?: "all" | "body" | "title";
    limit?: number;
    snippets?: boolean;
  } = {},
) {
  const out = new Map<string, ExactPairDescriptor>();
  if (
    !router?.metadata.completeContext ||
    alternative?.kind === "documents" ||
    alternative?.kind === "complete-terms"
  )
    return out;
  const wanted = new Map<string, { a: string; b: string }>();
  const membership = membershipPhrases(ast);
  const visit = (n: Node): void => {
    if (n.kind === "phrase") {
      if (n.terms.length < 2 || n.terms.length > 4) return;
      const pairs = n.terms
        .slice(1)
        .map((b, i) => ({ a: n.terms[i], b, at: i }))
        .filter((p) => p.at <= 1 && n.terms.length - p.at - 2 <= 1);
      const unknown = pairs.filter((p) => {
        const hot = directory?.lookup(p.a, p.b);
        if (!hot) return true;
        // A hot positional descriptor is not a membership payload. Price its
        // routed packet before starting the initial discovery wave.
        const leaf = router.route(p.a, p.b);
        return (
          membership.has(p.a + "\0" + p.b) &&
          leaf &&
          leaf.bytes < hot.directory.ranges.reduce((n, r) => n + r.length, 0) &&
          (!terms ||
            membershipIsCheaper(
              hot,
              [p.a, p.b],
              terms,
              options.field ?? "all",
              reader,
              options,
              leaf.bytes,
            ))
        );
      });
      if (!unknown.length) return;
      const already = unknown.filter((p) =>
        selected.some((s) => s.a === p.a && s.b === p.b),
      );
      const choices = already.length ? already : unknown;
      for (const p of choices) wanted.set(p.a + "\0" + p.b, p);
    } else if (n.kind === "not") visit(n.child);
    else if ("left" in n) {
      visit(n.left);
      visit(n.right);
    }
  };
  visit(ast);
  const packets = new Map<string, Promise<PairMembershipPacket>>();
  const absent = (a: string, b: string): ExactPairDescriptor => ({
    a,
    b,
    df: 0,
    bodyDf: 0,
    titleDf: 0,
    bodyOccurrences: 0,
    titleOccurrences: 0,
    directory: {
      a: 0,
      b: 0,
      generation: router.metadata.generation,
      ranges: [],
    },
  });
  for (const p of wanted.values()) {
    const leaf = router.route(p.a, p.b);
    if (!leaf) {
      out.set(p.a + "\0" + p.b, absent(p.a, p.b));
      continue;
    }
    const key = pairObjectKey(router.metadata.generation, leaf);
    if (!packets.has(key)) {
      reader.stats.exactPhraseDiscoveryReads++;
      reader.stats.exactPhraseDiscoveryBytes += leaf.bytes;
      packets.set(
        key,
        reader
          .named(key, leaf.bytes)
          .then((raw) => new PairMembershipPacket(raw)),
      );
    }
  }
  if (packets.size) reader.stats.exactPhraseDiscoveryWaves++;
  await Promise.all(packets.values());
  for (const [key, p] of wanted) {
    const leaf = router.route(p.a, p.b);
    if (!leaf) continue;
    const packet = await packets.get(
        pairObjectKey(router.metadata.generation, leaf),
      )!,
      r = packet.lookup(
        p.a,
        p.b,
        router.metadata.documents,
        (_row, _field, n, bytes) => {
          reader.stats.positionIntegers += n;
          reader.stats.pairContextIntegers += 2 * n;
          reader.stats.decodedBytes += bytes;
          reader.stats.exactPhraseOccurrences += n;
        },
        (_field, _block, n, bytes) => {
          reader.stats.pairMembershipIntegers += n;
          reader.stats.pairMembershipDecodedBytes += bytes;
          reader.stats.decodedBytes += bytes;
          reader.stats.postings += n;
        },
      );
    if (!r) {
      out.set(key, absent(p.a, p.b));
      continue;
    }
    if (
      r.completePositions &&
      r.completePositions.generation !== router.metadata.generation
    )
      throw Error("Complete context generation mismatch");
    if (!r.completePositions && !r.context)
      throw Error("Incomplete pair context in complete generation");
    out.set(key, {
      a: p.a,
      b: p.b,
      df: r.df,
      bodyDf: r.body.count,
      titleDf: r.title.count,
      bodyOccurrences: r.bodyOccurrences,
      titleOccurrences: r.titleOccurrences,
      directory: r.completePositions ?? {
        a: r.a,
        b: r.b,
        generation: router.metadata.generation,
        ranges: [],
      },
      inline: r.context,
      membership: r,
    });
  }
  return out;
}

export interface ExactPhrasePlan {
  words: string[];
  ids: number[];
  at: number;
  pair: ExactPairDescriptor;
  bytes: number;
  groups: ReturnType<typeof groups>;
  cost: number;
  alternativeCost: number;
  membershipOnly?: boolean;
}
/** Reprice a global stream after another Boolean branch has supplied actual
 * candidates. These proportional estimates choose execution, never prune it.
 * If both encoded work and occurrence work favor targeted verification, retain
 * the existing filtered block plan rather than scan unrelated pair occurrences.
 */
export function filteredPhraseWork(
  plan: ExactPhrasePlan,
  candidates: number,
  terms: ReadonlyMap<string, DirectoryTerm>,
  field: "all" | "body" | "title",
) {
  let bytes = 0,
    occurrences = 0;
  for (const name of new Set(plan.words)) {
    const t = terms.get(name)!;
    const fraction = Math.min(1, candidates / Math.max(1, t.df));
    bytes +=
      [t.positional, ...(t.positionalParts ?? [])].reduce(
        (n, r) => n + r[2],
        0,
      ) * fraction;
    occurrences +=
      ((field !== "title" ? t.bodyOccurrences : 0) +
        (field !== "body" ? t.titleOccurrences : 0)) *
      fraction;
  }
  const completeOccurrences =
    (field !== "title" ? plan.pair.bodyOccurrences : 0) +
    (field !== "body" ? plan.pair.titleOccurrences : 0);
  return {
    bytes,
    occurrences,
    completeOccurrences,
    preferFiltered: bytes < plan.bytes && occurrences < completeOccurrences,
  };
}
/** Stable contiguous extents, independent of query matches and application
 * cache state. Chunk boundaries remain the decoding/restart unit. */
function groups(pair: ExactPairDescriptor) {
  const out: {
    object: number;
    offset: number;
    length: number;
  }[] = [];
  for (const c of pair.directory.ranges)
    for (let at = 0; at < c.length; at += 262144)
      out.push({
        object: c.object,
        offset: c.offset + at,
        length: Math.min(262144, c.length - at),
      });
  return out;
}
/** Latency priors for choosing execution, never correctness bounds. Include
 * the dependent winner-position stage: zero membership payload bytes alone do
 * not imply a cheaper complete response. Discovery uses the same comparison
 * before starting I/O; an already required packet has no extra discovery cost. */
function membershipIsCheaper(
  pair: ExactPairDescriptor,
  words: string[],
  terms: ReadonlyMap<string, DirectoryTerm>,
  field: "all" | "body" | "title",
  reader: Reader | undefined,
  presentation: { limit?: number; snippets?: boolean },
  discoveryBytes = 0,
) {
  const missing = groups(pair).filter(
      (g) =>
        !reader?.namedResident(
          `${pair.directory.generation}/positions-${g.object}.bin@${g.offset}`,
          g.length,
        ),
    ),
    occurrences =
      (field !== "title" ? pair.bodyOccurrences : 0) +
      (field !== "body" ? pair.titleOccurrences : 0),
    contextMs =
      missing.reduce((n, g) => n + g.length, 0) / 104857.6 +
      Math.ceil(missing.length / 6) * 20 +
      occurrences / 3333,
    renderPages =
      presentation.snippets === false || field === "title"
        ? 0
        : [...new Set(words)].reduce((n, w) => {
            const t = terms.get(w);
            return (
              n +
              (t
                ? Math.min(
                    presentation.limit ?? 20,
                    Math.ceil(
                      [t.positional, ...(t.positionalParts ?? [])].reduce(
                        (n, r) => n + r[2],
                        0,
                      ) / 262144,
                    ),
                  )
                : 20)
            );
          }, 0),
    membershipMs =
      pair.df / 50000 +
      renderPages * 2.5 +
      // Winner positions are requested after scoring separate document
      // windows. They are not one parallel six-request wave: conservatively
      // charge a dependent cold stage per forecast page until that executor
      // supports cross-window positional batching.
      renderPages * 20 +
      (renderPages ? 20 : 0) +
      discoveryBytes / 104857.6 +
      (discoveryBytes ? 20 : 0);
  return membershipMs < contextMs;
}
/** Full execution costs, not a membership-saving override. Estimates choose
 * plans only; every selected stream has complete positional coverage. */
export function planExactPhrases(
  ast: Node,
  directory: Pick<ExactPhraseDirectory, "lookup"> | undefined,
  terms: ReadonlyMap<string, DirectoryTerm> | undefined,
  alternative: FilterAlternative | undefined,
  averageDocumentBytes: number,
  field: "all" | "body" | "title",
  reader?: Reader,
  presentation: { limit?: number; snippets?: boolean } = {},
) {
  if (!directory || !terms) return [];
  alternative ??= {
    kind: "blocks",
    expectedCandidates: Math.min(...[...terms.values()].map((t) => t.df)),
    frequencyBytes: [...terms.values()].reduce(
      (n, t) =>
        n +
        [t.frequencies, ...(t.frequencyParts ?? [])].reduce(
          (n, r) => n + r[2],
          0,
        ),
      0,
    ),
    positionBytes: [...terms.values()].reduce(
      (n, t) =>
        n +
        [t.positional, ...(t.positionalParts ?? [])].reduce(
          (n, r) => n + r[2],
          0,
        ),
      0,
    ),
  };
  const phrases = new Map<string, string[]>();
  const visit = (n: Node): void => {
    if (n.kind === "phrase") phrases.set(n.terms.join("\0"), n.terms);
    else if (n.kind === "not") visit(n.child);
    else if ("left" in n) {
      visit(n.left);
      visit(n.right);
    }
  };
  visit(ast);
  const result: ExactPhrasePlan[] = [];
  const truthOnly = membershipPhrases(ast);
  for (const words of phrases.values()) {
    if (
      words.length < 2 ||
      words.length > 4 ||
      words.some((w) => !terms.has(w))
    )
      continue;
    const ids = words.map((w) => terms.get(w)!.id),
      choices: ExactPhrasePlan[] = [];
    const frequencyBytes = [...new Set(words)].reduce((n, w) => {
      const t = terms.get(w)!;
      return (
        n +
        [t.frequencies, ...(t.frequencyParts ?? [])].reduce(
          (n, r) => n + (reader?.resident(r) ? 0 : r[2]),
          0,
        )
      );
    }, 0);
    for (let at = 0; at + 1 < words.length; at++) {
      if (at > 1 || words.length - at - 2 > 1) continue;
      const pair = directory.lookup(words[at], words[at + 1]);
      if (!pair) continue;
      if (
        pair.df &&
        (pair.directory.a !== ids[at] || pair.directory.b !== ids[at + 1])
      )
        throw Error("Exact phrase term identity mismatch");
      const fullGroups = groups(pair),
        membershipOnly =
          !!pair.membership &&
          !pair.inline &&
          truthOnly.has(words.join("\0")) &&
          membershipIsCheaper(pair, words, terms, field, reader, presentation),
        gs = membershipOnly ? [] : fullGroups,
        bytes = gs.reduce((n, g) => n + g.length, 0),
        occ = membershipOnly
          ? pair.df
          : (field !== "title" ? pair.bodyOccurrences : 0) +
            (field !== "body" ? pair.titleOccurrences : 0);
      const missing = gs.filter(
        (g) =>
          !reader?.namedResident(
            `${pair.directory.generation}/positions-${g.object}.bin@${g.offset}`,
            g.length,
          ),
      );
      const scoreCost = frequencyBytes / 262144 + (frequencyBytes ? 8 : 0);
      const cost =
        missing.reduce((n, g) => n + g.length, 0) / 262144 +
        Math.ceil(missing.length / 6) * 8 +
        occ / 250000 +
        scoreCost;
      const completeCost =
        (frequencyBytes +
          [...new Set(words)].reduce((n, w) => {
            const t = terms.get(w)!;
            return (
              n +
              [t.positional, ...(t.positionalParts ?? [])].reduce(
                (n, r) => n + (reader?.resident(r) ? 0 : r[2]),
                0,
              )
            );
          }, 0)) /
          262144 +
        16 +
        [...new Set(words)].reduce((n, w) => {
          const t = terms.get(w)!;
          return (
            n +
            (field !== "title" ? t.bodyOccurrences : 0) +
            (field !== "body" ? t.titleOccurrences : 0)
          );
        }, 0) /
          250000;
      const documentCost =
        (alternative.expectedCandidates * averageDocumentBytes) / 262144 +
        Math.ceil(alternative.expectedCandidates / 6) * 8;
      const alternativeCost = Math.min(completeCost, documentCost);
      // A known empty field is a complete local answer, even underneath NOT.
      const empty =
        (field === "body"
          ? pair.bodyDf
          : field === "title"
            ? pair.titleDf
            : pair.df) === 0;
      if (empty || cost < alternativeCost)
        choices.push({
          words,
          ids,
          at,
          pair,
          bytes,
          groups: empty ? [] : gs,
          cost: empty ? 0 : cost,
          alternativeCost,
          membershipOnly,
        });
    }
    choices.sort((a, b) => a.cost - b.cost || a.bytes - b.bytes || a.at - b.at);
    if (choices[0]) result.push(choices[0]);
  }
  return result;
}
const EMPTY = new Uint32Array();
type MatchBatch = {
  docs: Uint32Array;
  offsets: Uint32Array[];
  starts: Uint32Array[];
};
/** Bounded encoded prefetch; each chunk decoded exactly once. A split document
 * is completed before emission so proximity sees all its phrase positions. */
async function* matches(
  plan: ExactPhrasePlan,
  reader: Reader,
  field: "all" | "body" | "title",
): AsyncGenerator<MatchBatch> {
  const pending = new Map<number, Promise<Uint8Array>>();
  const start = (i: number) => {
    if (i >= plan.groups.length || pending.has(i)) return;
    const g = plan.groups[i];
    reader.stats.exactPhraseReads++;
    reader.stats.exactPhraseBytes += g.length;
    const task = reader.named(
      `${plan.pair.directory.generation}/positions-${g.object}.bin@${g.offset}`,
      g.length,
    );
    task.catch(() => {});
    pending.set(i, task);
  };
  let doc = -1,
    body: number[] = [],
    title: number[] = [];
  let docs: number[] = [],
    offsets = [[0], [0]],
    starts: number[][] = [[], []];
  const append = () => {
    if (!body.length && !title.length) return;
    docs.push(doc);
    for (const f of [0, 1]) {
      for (const p of f ? title : body) starts[f].push(p);
      offsets[f].push(starts[f].length);
    }
  };
  const emit = (): MatchBatch => {
    const batch = {
      docs: Uint32Array.from(docs),
      offsets: offsets.map((a) => Uint32Array.from(a)),
      starts: starts.map((a) => Uint32Array.from(a)),
    };
    docs = [];
    offsets = [[0], [0]];
    starts = [[], []];
    return batch;
  };
  let carry = new Uint8Array();
  for (let i = 0; i < (plan.pair.inline ? 1 : plan.groups.length); i++) {
    for (let j = i; j < i + 6; j++) start(j);
    const fetched = plan.pair.inline ? new Uint8Array() : await pending.get(i)!;
    const raw = carry.length ? concat([carry, fetched]) : fetched;
    pending.delete(i);
    reader.stats.peakExactPhraseBufferBytes = Math.max(
      reader.stats.peakExactPhraseBufferBytes,
      Math.min(plan.bytes, 6 * 262144),
    );
    let at = 0;
    while (plan.pair.inline ? at === 0 : at + 24 <= raw.length) {
      let p: PairPacket, length: number;
      if (plan.pair.inline) {
        p = plan.pair.inline;
        length = 1;
      } else {
        const v = view(raw.subarray(at)),
          size =
            24 +
            v.getUint32(12, true) +
            v.getUint32(16, true) +
            v.getUint32(20, true);
        length = size;
        if (length < 24 || length > 65536)
          throw Error("Invalid exact phrase chunk length");
        if (at + length > raw.length) break;
        p = new PairPacket(
          raw.subarray(at, at + length),
          (_row, _f, n, bytes) => {
            reader.stats.positionIntegers += n;
            reader.stats.pairContextIntegers += 2 * n;
            reader.stats.decodedBytes += bytes;
            reader.stats.exactPhraseOccurrences += n;
          },
        );
      }
      if (
        p.a !== plan.ids[plan.at] ||
        p.b !== plan.ids[plan.at + 1] ||
        p.docs[0] < doc
      )
        throw Error("Exact phrase chunk identity mismatch");
      for (let row = 0; row < p.docs.length; row++) {
        const next = p.docs[row];
        if (doc !== next) {
          if (doc >= 0) append();
          doc = next;
          body = [];
          title = [];
        }
        if (field !== "title")
          for (const pos of p.phrase(row, 0, plan.ids, plan.at).starts)
            body.push(pos);
        if (field !== "body")
          for (const pos of p.phrase(row, 1, plan.ids, plan.at).starts)
            title.push(pos);
        if (body.length + title.length > 262144)
          throw new QueryResourceError("Positional span limit exceeded");
      }
      if (docs.length >= 128) yield emit();
      at += length;
    }
    carry = plan.pair.inline ? new Uint8Array() : raw.slice(at);
    if (carry.length >= 65536) throw Error("Unbounded exact phrase carry");
  }
  if (carry.length) throw Error("Truncated exact phrase stream");
  if (doc >= 0) append();
  if (docs.length) yield emit();
}
class PhraseStream {
  private current?: IteratorResult<MatchBatch>;
  private row = 0;
  private iterator: AsyncGenerator<MatchBatch>;
  private docs = EMPTY;
  private offsets = [Uint32Array.of(0), Uint32Array.of(0)];
  private starts = [EMPTY, EMPTY];
  constructor(
    readonly plan: ExactPhrasePlan,
    readonly reader: Reader,
    field: "all" | "body" | "title",
  ) {
    this.iterator = matches(plan, reader, field);
  }
  async window(lo: number, hi: number) {
    const docs: number[] = [],
      offsets = [[0], [0]],
      starts: number[][] = [[], []];
    this.current ??= await this.iterator.next();
    while (!this.current.done) {
      const m = this.current.value;
      if (m.docs[this.row] >= hi) break;
      if (m.docs[this.row] >= lo) {
        docs.push(m.docs[this.row]);
        for (const f of [0, 1]) {
          for (
            let j = m.offsets[f][this.row];
            j < m.offsets[f][this.row + 1];
            j++
          )
            starts[f].push(m.starts[f][j]);
          offsets[f].push(starts[f].length);
        }
      }
      if (++this.row === m.docs.length) {
        this.current = await this.iterator.next();
        this.row = 0;
      }
    }
    this.docs = Uint32Array.from(docs);
    this.offsets = offsets.map((a) => Uint32Array.from(a));
    this.starts = starts.map((a) => Uint32Array.from(a));
    this.reader.stats.exactPhraseMatches += docs.length;
  }
  snapshot(): MatchBatch {
    return { docs: this.docs, offsets: this.offsets, starts: this.starts };
  }
}
type EvidenceWindow = {
  lo: number;
  hi: number;
  phrases: Map<string, MatchBatch>;
  memberships: Map<string, [Uint8Array, Uint8Array]>;
  bytes: number;
};

export class ExactPhraseExecution {
  private streams = new Map<string, PhraseStream>();
  private memberships = new Map<
    string,
    {
      cursors: ReturnType<
        NonNullable<ExactPairDescriptor["membership"]>["body"]["cursor"]
      >[];
      next: number[];
    }
  >();
  private keys = new WeakMap<string[], string>();
  private windows = new Map<number, EvidenceWindow>();
  private active?: EvidenceWindow;
  constructor(
    readonly plans: ExactPhrasePlan[],
    readonly reader: Reader,
    field: "all" | "body" | "title",
  ) {
    for (const p of plans) {
      const key = p.words.join("\0");
      if (p.membershipOnly) {
        const cursors = [
          p.pair.membership!.body.cursor(),
          p.pair.membership!.title.cursor(),
        ];
        this.memberships.set(key, {
          cursors,
          next: cursors.map((c) => c.next()),
        });
      } else this.streams.set(key, new PhraseStream(p, reader, field));
    }
  }
  private key = (words: string[]) => {
    let key = this.keys.get(words);
    if (key === undefined) {
      key = words.join("\0");
      this.keys.set(words, key);
    }
    return key;
  };
  covered = (words: string[]) => this.streams.has(this.key(words));
  /** A membership-proven absent phrase needs none of its ordinary word
   * positions. Keep reads required by any other phrase or explicit term use.
   * The renderer and positional evaluator still receive genuine positions
   * wherever the phrase may match. */
  positionGuard(
    ast: Node,
    covered: (words: string[]) => boolean,
    field: "all" | "body" | "title",
  ) {
    const unguarded = positionalTerms(
      ast,
      (words) => covered(words) || this.memberships.has(this.key(words)),
    );
    const visit = (n: Node): void => {
      if (n.kind === "term") unguarded.add(n.term);
      else if (n.kind === "not") visit(n.child);
      else if ("left" in n) {
        visit(n.left);
        visit(n.right);
      }
    };
    visit(ast);
    const guarded = new Map<string, string[][]>();
    for (const p of this.plans)
      if (p.membershipOnly)
        for (const word of p.words)
          if (!unguarded.has(word)) {
            if (!guarded.has(word)) guarded.set(word, []);
            guarded.get(word)!.push(p.words);
          }
    return (word: string, doc: number) => {
      const phrases = guarded.get(word);
      if (!phrases) return true;
      for (const words of phrases)
        if (
          (field !== "title" && this.truth(words, doc, 0) !== false) ||
          (field !== "body" && this.truth(words, doc, 1) !== false)
        )
          return true;
      return false;
    };
  }
  private locate(doc: number) {
    if (this.active && doc >= this.active.lo && doc < this.active.hi)
      return this.active;
    for (const w of this.windows.values())
      if (doc >= w.lo && doc < w.hi) return (this.active = w);
    throw Error("Phrase evidence outside buffered windows");
  }
  evidence = (
    words: string[],
    doc: number,
    f: number,
  ): Uint32Array | undefined => {
    const key = this.key(words);
    if (!this.streams.has(key)) return;
    const m = this.locate(doc).phrases.get(key)!,
      row = lower(m.docs, doc);
    return m.docs[row] === doc
      ? m.starts[f].subarray(m.offsets[f][row], m.offsets[f][row + 1])
      : EMPTY;
  };
  truth = (words: string[], doc: number, f: number): boolean | undefined => {
    const key = this.key(words);
    if (!this.memberships.has(key)) return;
    const w = this.locate(doc);
    return !!w.memberships.get(key)![f][doc - w.lo];
  };
  get bufferBytes() {
    return [...this.windows.values()].reduce((n, w) => n + w.bytes, 0);
  }
  release(lo: number) {
    this.windows.delete(lo);
    if (this.active?.lo === lo) this.active = undefined;
  }
  async window(lo: number, hi: number) {
    const old = this.windows.get(lo);
    if (old) {
      this.active = old;
      return;
    }
    if (this.windows.size >= 8) throw Error("Unbounded phrase lookahead");
    await Promise.all([...this.streams.values()].map((s) => s.window(lo, hi)));
    const phrases = new Map(
        [...this.streams].map(([key, s]) => [key, s.snapshot()]),
      ),
      memberships = new Map<string, [Uint8Array, Uint8Array]>();
    for (const [key, state] of this.memberships) {
      const masks: [Uint8Array, Uint8Array] = [
        new Uint8Array(hi - lo),
        new Uint8Array(hi - lo),
      ];
      for (const f of [0, 1]) {
        while (state.next[f] < lo) state.next[f] = state.cursors[f].next();
        while (state.next[f] < hi) {
          masks[f][state.next[f] - lo] = 1;
          state.next[f] = state.cursors[f].next();
        }
      }
      memberships.set(key, masks);
    }
    const bytes =
      [...phrases.values()].reduce(
        (n, m) =>
          n +
          m.docs.byteLength +
          [...m.offsets, ...m.starts].reduce((n, a) => n + a.byteLength, 0),
        0,
      ) +
      [...memberships.values()].reduce(
        (n, a) => n + a[0].byteLength + a[1].byteLength,
        0,
      );
    this.active = { lo, hi, phrases, memberships, bytes };
    this.windows.set(lo, this.active);
    this.reader.stats.peakExactPhraseBufferBytes = Math.max(
      this.reader.stats.peakExactPhraseBufferBytes,
      this.bufferBytes + this.streams.size * 6 * 262144,
    );
    this.reader.stats.peakExactPhraseWindows = Math.max(
      this.reader.stats.peakExactPhraseWindows,
      this.windows.size,
    );
  }
  /** Numeric truth columns avoid a binary search, subarray and closure per
   * possible document. Unknown branches retain complete Boolean coverage. */
  mask(ast: Node, field: "all" | "body" | "title") {
    const window = this.active!,
      size = window.hi - window.lo,
      cache = new Map<string, Uint8Array>();
    type Truth = number | Uint8Array;
    const at = (t: Truth, i: number) => (typeof t === "number" ? t : t[i]);
    const visit = (n: Node): Truth => {
      if (n.kind === "empty") return 0;
      if (n.kind === "all") return 1;
      if (n.kind === "term") return 2;
      if (n.kind === "phrase") {
        const key = this.key(n.terms),
          s = window.phrases.get(key),
          membership = window.memberships.get(key);
        if (!s && !membership) return 2;
        let a = cache.get(key);
        if (!a) {
          a = new Uint8Array(size);
          if (membership) {
            for (let i = 0; i < size; i++)
              a[i] =
                (field !== "title" && membership[0][i]) ||
                (field !== "body" && membership[1][i])
                  ? 1
                  : 0;
          } else
            for (let row = 0; row < s!.docs.length; row++)
              if (
                (field !== "title" &&
                  s!.offsets[0][row + 1] > s!.offsets[0][row]) ||
                (field !== "body" &&
                  s!.offsets[1][row + 1] > s!.offsets[1][row])
              )
                a[s!.docs[row] - window.lo] = 1;
          cache.set(key, a);
        }
        return a;
      }
      if (n.kind === "not") {
        const a = visit(n.child);
        if (typeof a === "number") return a === 2 ? 2 : 1 - a;
        return a.map((v) => (v === 2 ? 2 : 1 - v));
      }
      const a = visit(n.left),
        b = visit(n.right),
        out = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        const x = at(a, i),
          y = at(b, i);
        out[i] =
          n.kind === "or"
            ? x === 1 || y === 1
              ? 1
              : x === 0 && y === 0
                ? 0
                : 2
            : n.kind === "except"
              ? x === 0 || y === 1
                ? 0
                : x === 1 && y === 0
                  ? 1
                  : 2
              : x === 0 || y === 0
                ? 0
                : n.kind !== "near" && x === 1 && y === 1
                  ? 1
                  : 2;
      }
      return out;
    };
    const value = visit(ast);
    return typeof value === "number"
      ? new Uint8Array(size).fill(value === 0 ? 0 : 1)
      : value.map((v) => (v === 0 ? 0 : 1));
  }
}
