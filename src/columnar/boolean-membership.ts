import type { Node } from "../query/parser.js";
import type { Reader } from "./storage.js";
import {
  planMembershipAnchor,
  readMembershipAnchor,
  membershipAnchor,
  type MembershipSettings,
  type FilterAlternative,
  type PairReadPlan,
  type MembershipSelection,
  type MembershipAnchor,
} from "./membership-anchor.js";
import { pairObjectKey } from "./pair-router.js";
import {
  pairKey,
  pairPhraseEvidence,
  pairPhraseCovered,
} from "./pair-evidence.js";
import {
  intersectCursors,
  unionCursors,
  arrayCursor,
  type NumericCursor,
} from "./numeric-cursor.js";
import type { PairPacket } from "./pair-packet.js";
import type { PairEvidence } from "./pair-positions.js";
import { lower } from "./format.js";
type Tree =
  | { kind: "phrase"; plan: PairReadPlan }
  | {
      kind: "known";
      words: string[];
      anchor: (field: "all" | "body" | "title") => MembershipAnchor;
    }
  | { kind: "and" | "or" | "near"; left: Tree; right: Tree };
export interface BooleanMembershipPlan {
  tree: Tree;
  plans: PairReadPlan[];
  pairs: PairReadPlan["pairs"];
  expectedCandidates: number;
  provedWords: ReadonlySet<string>;
}
/** Unknown is the universe. AND may keep either known side; OR requires both.
 * Negative supersets cannot safely be subtracted, including double negation. */
export function planBooleanMembership(
  ast: Node,
  settings: MembershipSettings,
  words?: ReadonlyMap<string, { df: number }>,
  candidateBytes = 16384,
  field: "all" | "body" | "title" = "all",
  alternative?: FilterAlternative,
  exactTotal = false,
  known?: (
    phrase: Extract<Node, { kind: "phrase" }>,
    field: "all" | "body" | "title",
  ) => MembershipAnchor | undefined,
): BooleanMembershipPlan | undefined {
  const phrases = new Map<string, PairReadPlan | undefined>();
  function visit(n: Node): Tree | undefined {
    if (n.kind === "phrase") {
      if (known?.(n, field))
        return { kind: "known", words: n.terms, anchor: (f) => known(n, f)! };
      const key = JSON.stringify(n.terms);
      if (!phrases.has(key)) {
        let plan = planMembershipAnchor(
          n,
          settings,
          words,
          candidateBytes,
          field,
          alternative,
          exactTotal,
        );
        // The tail DF prior cannot price a Boolean intersection reliably. A
        // bounded unknown-pair probe discovers actual membership before paying
        // for a large block scan; estimates never become pruning evidence.
        if (
          !plan &&
          ast.kind !== "phrase" &&
          alternative?.kind === "blocks" &&
          alternative.frequencyBytes > 1048576
        ) {
          const probes = n.terms
            .slice(1)
            .flatMap((b, i) => {
              const a = n.terms[i],
                leaf = settings.router.route(a, b);
              return !settings.router.statistics(a, b) &&
                leaf &&
                leaf.bytes <= 262144
                ? [
                    {
                      a,
                      b,
                      bytes: leaf.bytes,
                      df: Math.min(
                        words?.get(a)?.df ?? settings.router.metadata.documents,
                        words?.get(b)?.df ?? settings.router.metadata.documents,
                      ),
                    },
                  ]
                : [];
            })
            .sort((a, b) => a.df - b.df || a.bytes - b.bytes);
          if (probes.length) {
            const pair = probes[0];
            plan = {
              words: n.terms,
              pairs: [pair],
              absent: false,
              expectedCandidates: pair.df,
              readWork: pair.bytes,
              savedWork: alternative.frequencyBytes,
            };
          }
        }
        phrases.set(key, plan);
      }
      const plan = phrases.get(key);
      return plan ? { kind: "phrase", plan } : undefined;
    }
    if (!("left" in n)) return;
    const left = visit(n.left);
    if (n.kind === "except") return left;
    const right = visit(n.right);
    if (n.kind === "or")
      return left && right ? { kind: "or", left, right } : undefined;
    if (!left) return right;
    if (!right) return left;
    return { kind: n.kind, left, right };
  }
  let tree = visit(ast);
  if (!tree) return;
  function collect(n: Tree): PairReadPlan[] {
    if (n.kind === "known") return [];
    return n.kind === "phrase"
      ? [n.plan]
      : [...collect(n.left), ...collect(n.right)];
  }
  let plans = [...new Set(collect(tree))];
  const objects = new Map<string, number>();
  for (const p of plans)
    for (const pair of p.pairs) {
      const leaf = settings.router.route(pair.a, pair.b)!;
      objects.set(
        pairObjectKey(settings.router.metadata.generation, leaf),
        leaf.bytes,
      );
    }
  // Additional branch evidence is bounded. Fall back to the existing mandatory
  // anchor instead of dropping one OR side and accidentally losing recall.
  if (
    plans.length > 1 &&
    [...objects.values()].reduce((n, b) => n + b, 0) > 8 * 1048576
  ) {
    const plan = planMembershipAnchor(
      ast,
      settings,
      words,
      candidateBytes,
      field,
      alternative,
      exactTotal,
    );
    if (!plan) return;
    tree = { kind: "phrase", plan };
    plans = [plan];
  }
  function estimate(n: Tree): number {
    if (n.kind === "known") return n.anchor(field).count;
    if (n.kind === "phrase") return n.plan.expectedCandidates;
    const a = estimate(n.left),
      b = estimate(n.right);
    return n.kind === "or"
      ? Math.min(settings.router.metadata.documents, a + b)
      : Math.min(a, b);
  }
  function proved(n: Tree): Set<string> {
    if (n.kind === "known") return new Set(n.words);
    if (n.kind === "phrase")
      return new Set(n.plan.pairs.flatMap((p) => [p.a, p.b]));
    const a = proved(n.left),
      b = proved(n.right);
    return n.kind === "or"
      ? new Set([...a].filter((word) => b.has(word)))
      : new Set([...a, ...b]);
  }
  return {
    tree,
    plans,
    pairs: plans.flatMap((p) => p.pairs),
    expectedCandidates: estimate(tree),
    provedWords: proved(tree),
  };
}
export async function readBooleanMembership(
  plan: BooleanMembershipPlan,
  reader: Reader,
  settings: MembershipSettings,
) {
  const selections = new Map<PairReadPlan, MembershipSelection>(
    await Promise.all(
      plan.plans.map(
        async (p) =>
          [p, await readMembershipAnchor(p, reader, settings)] as const,
      ),
    ),
  );
  return { tree: plan.tree, selections };
}
/** Compose newly completed phrase evidence with memberships already fetched.
 * This rebuilds only the Boolean expression; it never schedules another read.
 * Unknown OR branches remain unknown and negative supersets are not subtracted. */
export function refineBooleanMembership(
  selection: Awaited<ReturnType<typeof readBooleanMembership>>,
  ast: Node,
  field: "all" | "body" | "title",
  known: (
    words: string[],
    field: "all" | "body" | "title",
  ) => MembershipAnchor | undefined,
) {
  const plans = new Map(
      [...selection.selections.keys()].map((p) => [p.words.join("\0"), p]),
    ),
    existing = new Map<string, Extract<Tree, { kind: "known" }>>();
  const collect = (n: Tree): void => {
    if (n.kind === "known") existing.set(n.words.join("\0"), n);
    else if (n.kind !== "phrase") {
      collect(n.left);
      collect(n.right);
    }
  };
  collect(selection.tree);
  const visit = (n: Node): Tree | undefined => {
    if (n.kind === "phrase") {
      const source = known(n.terms, field),
        key = n.terms.join("\0");
      if (source)
        return {
          kind: "known",
          words: n.terms,
          anchor: (f) => known(n.terms, f) ?? source,
        };
      const old = existing.get(key);
      if (old) return old;
      const plan = plans.get(key);
      return plan ? { kind: "phrase", plan } : undefined;
    }
    if (!("left" in n)) return;
    const left = visit(n.left);
    if (n.kind === "except") return left;
    const right = visit(n.right);
    if (n.kind === "or")
      return left && right ? { kind: "or", left, right } : undefined;
    if (!left) return right;
    if (!right) return left;
    return { kind: n.kind, left, right };
  };
  return { ...selection, tree: visit(ast) ?? selection.tree };
}
export function booleanMembershipAnchor(
  selection: Awaited<ReturnType<typeof readBooleanMembership>>,
  ids: Map<string, number>,
  field: "all" | "body" | "title",
): MembershipAnchor {
  if (selection.tree.kind === "known") return selection.tree.anchor(field);
  if (selection.tree.kind === "phrase")
    return membershipAnchor(
      selection.selections.get(selection.tree.plan)!,
      ids,
      field,
    );
  type Stream = { cursor: () => NumericCursor; has: (doc: number) => boolean };
  const cached = new Map<PairReadPlan, Map<string, MembershipAnchor>>();
  function compile(n: Tree, f: typeof field): Stream {
    if (n.kind === "known") return n.anchor(f);
    if (n.kind === "phrase") {
      let fields = cached.get(n.plan);
      if (!fields) {
        fields = new Map();
        cached.set(n.plan, fields);
      }
      let a = fields.get(f);
      if (!a) {
        a = membershipAnchor(selection.selections.get(n.plan)!, ids, f);
        fields.set(f, a);
      }
      return a;
    }
    if (n.kind === "near" && f === "all") {
      const body = compile(n, "body"),
        title = compile(n, "title");
      return {
        cursor: () => unionCursors(body.cursor(), title.cursor()),
        has: (doc) => body.has(doc) || title.has(doc),
      };
    }
    const a = compile(n.left, f),
      b = compile(n.right, f);
    return n.kind === "or"
      ? {
          cursor: () => unionCursors(a.cursor(), b.cursor()),
          has: (doc) => a.has(doc) || b.has(doc),
        }
      : {
          cursor: () => intersectCursors([a.cursor(), b.cursor()]),
          has: (doc) => a.has(doc) && b.has(doc),
        };
  }
  const filter = compile(selection.tree, field),
    packets = new Map<string, PairEvidence>(),
    known = new Map<string, Extract<Tree, { kind: "known" }>>();
  const collectKnown = (n: Tree): void => {
    if (n.kind === "known") known.set(n.words.join("\0"), n);
    else if (n.kind !== "phrase") {
      collectKnown(n.left);
      collectKnown(n.right);
    }
  };
  collectKnown(selection.tree);
  for (const s of selection.selections.values())
    for (const record of s.records)
      if (record.supplementalContext ?? record.context)
        packets.set(
          pairKey(record.a, record.b),
          (record.supplementalContext ?? record.context)!,
        );
  const stream = filter.cursor;
  // Retain a small final intersection once. Pricing, context refinement and
  // scoring reuse it instead of repeatedly decoding its larger input lists.
  // Broad results retain streaming execution with a fixed 256 KiB ceiling.
  const limit = 65536;
  let docs: Uint32Array | undefined = new Uint32Array(128);
  let count = 0;
  const c = stream();
  for (let doc = c.next(); doc !== Infinity; doc = c.next()) {
    if (docs) {
      if (count === limit) docs = undefined;
      else {
        if (count === docs.length) {
          const grown: Uint32Array = new Uint32Array(
            Math.min(limit, docs.length * 2),
          );
          grown.set(docs);
          docs = grown;
        }
        docs![count] = doc;
      }
    }
    count++;
  }
  docs = docs?.subarray(0, count);
  const cursor = docs ? () => arrayCursor(docs!) : stream;
  function* values() {
    const c = cursor();
    for (let doc = c.next(); doc !== Infinity; doc = c.next()) yield doc;
  }
  const evidence = pairPhraseEvidence(packets, ids);
  return {
    ...filter,
    has: docs ? (doc) => docs![lower(docs!, doc)] === doc : filter.has,
    cursor,
    values,
    count,
    bufferBytes: docs?.buffer.byteLength ?? 0,
    evidence: (words, doc, f) =>
      known
        .get(words.join("\0"))
        ?.anchor(f ? "title" : "body")
        .evidence(words, doc, f) ?? evidence(words, doc, f),
    covered: (words) =>
      known.has(words.join("\0")) || pairPhraseCovered(packets, ids, words),
  };
}
