import { Heap } from "./top-k.js";
import type { DocumentDirectory } from "./document-directory.js";
import type { TermDirectory, DirectoryTerm } from "./term-directory.js";
import {
  executePackets,
  packageResult,
  type CandidatePackages,
} from "./packet-execution.js";
import { renderResults } from "./render.js";
import {
  parse,
  queryTerms,
  positional,
  positionalTerms,
  simplify,
  type Node,
} from "../query/parser.js";
import { positionalMatcher, QueryResourceError } from "../query/evaluate.js";
import type { DecodedPostings } from "../format/codec.js";
import {
  type Root,
  type PairRoot,
  type Term,
  type Branch,
  type Ref,
  type Scores,
  decodeScores,
  lower,
  refAt,
  view,
  unpack,
} from "./format.js";
import { Reader } from "./storage.js";
import { loadDictionary } from "./dictionary.js";
import { verifyForward, type PairBatch } from "./forward.js";
import type { Heads } from "./heads.js";
export interface Options {
  mode?: "and" | "or";
  limit?: number;
  field?: "all" | "body" | "title";
  titleBoost?: number;
  after?: { score: number; doc: number };
  metadata?: boolean;
  snippets?: boolean;
  exactTotal?: boolean;
}
const triAnd = (a: number, b: number) =>
  a === 0 || b === 0 ? 0 : a === 1 && b === 1 ? 1 : 2;
/** Three-valued predicate: 0=false, 1=true, 2=unknown. Negated positional
 * conditions cannot be decided from frequencies, including double negation. */
export function coarse(ast: Node, present: (term: string) => number): number {
  if (ast.kind === "empty") return 0;
  if (ast.kind === "all") return 1;
  if (ast.kind === "term") return present(ast.term);
  if (ast.kind === "phrase")
    return ast.terms.some((t) => present(t) === 0) ? 0 : 2;
  if (ast.kind === "not") {
    const a = coarse(ast.child, present);
    return a === 2 ? 2 : 1 - a;
  }
  const a = coarse(ast.left, present),
    b = coarse(ast.right, present);
  if (ast.kind === "or")
    return a === 1 || b === 1 ? 1 : a === 0 && b === 0 ? 0 : 2;
  if (ast.kind === "except") return triAnd(a, b === 2 ? 2 : 1 - b);
  const c = triAnd(a, b);
  return ast.kind === "near" && c !== 0 ? 2 : c;
}
function compileCoarse(
  ast: Node,
  index: Map<string, number>,
  present: (j: number, d: number) => number,
): (d: number) => number {
  if (ast.kind === "empty") return () => 0;
  if (ast.kind === "all") return () => 1;
  if (ast.kind === "term") {
    const j = index.get(ast.term)!;
    return (d) => present(j, d);
  }
  if (ast.kind === "phrase") {
    const js = ast.terms.map((t) => index.get(t)!);
    return (d) => {
      for (let i = 0; i < js.length; i++) if (!present(js[i], d)) return 0;
      return 2;
    };
  }
  if (ast.kind === "not") {
    const c = compileCoarse(ast.child, index, present);
    return (d) => {
      const a = c(d);
      return a === 2 ? 2 : 1 - a;
    };
  }
  const left = compileCoarse(ast.left, index, present),
    right = compileCoarse(ast.right, index, present);
  if (ast.kind === "or")
    return (d) => {
      const a = left(d);
      if (a === 1) return 1;
      const b = right(d);
      return b === 1 ? 1 : a === 0 && b === 0 ? 0 : 2;
    };
  if (ast.kind === "except")
    return (d) => {
      const a = left(d);
      if (!a) return 0;
      const b = right(d);
      return triAnd(a, b === 2 ? 2 : 1 - b);
    };
  if (ast.kind === "near")
    return (d) => (triAnd(left(d), right(d)) === 0 ? 0 : 2);
  return (d) => triAnd(left(d), right(d));
}
function mandatory(ast: Node): Set<string> {
  if (ast.kind === "term") return new Set([ast.term]);
  if (ast.kind === "phrase") return new Set(ast.terms);
  if (!("left" in ast)) return new Set();
  const a = mandatory(ast.left),
    b = mandatory(ast.right);
  if (ast.kind === "or") return new Set([...a].filter((t) => b.has(t)));
  if (ast.kind === "except") return a;
  return new Set([...a, ...b]);
}
export async function leaves(
  reader: Reader,
  branch: Branch,
  lo: number,
  hi: number,
): Promise<Branch[]> {
  if (branch.last < lo || branch.first >= hi) return [];
  if (!branch.height) return [branch];
  const children = await reader.branches(branch.score);
  return (
    await Promise.all(
      children
        .filter((b) => b.last >= lo && b.first < hi)
        .map((b) => leaves(reader, b, lo, hi)),
    )
  ).flat();
}
async function* leafStream(
  reader: Reader,
  branch: Branch,
): AsyncGenerator<Branch> {
  if (!branch.height) {
    yield branch;
    return;
  }
  for (const child of await reader.branches(branch.score))
    yield* leafStream(reader, child);
}
export class ColumnarIndex {
  constructor(
    readonly root: Root,
    readonly heads?: Heads,
    readonly directory?: TermDirectory,
    readonly packages?: CandidatePackages,
    readonly documentDirectory?: DocumentDirectory,
  ) {
    if (
      root.format !== "CWS1" ||
      !/^[a-f0-9]{64}$/.test(root.generation) ||
      !root.count ||
      (documentDirectory && documentDirectory.count !== root.count) ||
      (!root.documentPackages &&
        root.documents.length !== Math.ceil(root.count / 4096)) ||
      (root.documentPackages &&
        (!/^[a-f0-9]{64}$/.test(root.documentPackages.generation) ||
          root.documentPackages.count !== root.count ||
          root.documentPackages.averageBytes <= 0)) ||
      (root.objectIds &&
        (root.objectIds.length !== root.objects.length ||
          root.objectIds.some(
            (id, i) =>
              !Number.isInteger(id) ||
              id < 0 ||
              id > 0xffffffff ||
              (i > 0 && id <= root.objectIds![i - 1]),
          )))
    )
      throw Error("Invalid CWS1 root");
  }
  terms(
    names: string[],
    reader: Reader,
    routing: Pick<Root, "hot" | "dictionaries" | "dictionaryHeight"> = this
      .root,
  ) {
    if (routing === this.root && this.directory)
      return this.directory.lookup(names);
    return this.dictionary(names, reader, routing);
  }
  async dictionary<T>(
    names: string[],
    reader: Reader,
    routing: Pick<Root, "dictionaries" | "dictionaryHeight"> & {
      hot: Record<string, T>;
    },
  ) {
    return loadDictionary<T>(names, reader, routing);
  }
  async search(
    q: string,
    reader: Reader,
    options: Options = {},
    pairs?: { root: PairRoot; reader: Reader },
  ) {
    if (this.heads && !this.directory) {
      const ast = parse(q, options.mode),
        started = performance.now();
      if (ast.kind === "term") {
        const results = await this.heads.search(ast.term, reader, options);
        if (results)
          return {
            results,
            total: undefined,
            generation: this.root.generation,
            diagnostics: {
              ...reader.stats,
              pair: undefined,
              executor: "certified-head",
              wallMs: performance.now() - started,
              retainedPageBytes: reader.memory.pages.bytes,
              retainedDecodedBytes: reader.memory.decoded.bytes,
            },
          };
      }
    }
    const started = performance.now(),
      original = parse(q, options.mode),
      terms = await this.terms(queryTerms(original), reader),
      ast = simplify(original, (t) => terms.has(t)),
      names = queryTerms(ast),
      positive = new Set(queryTerms(ast, true)),
      positions = positional(ast),
      wantedPositions = positionalTerms(ast),
      limit = options.limit ?? 20,
      boost = options.titleBoost ?? 2,
      field = options.field ?? "all",
      heap = new Heap(limit);
    const packages =
      this.packages ??
      (this.root.documentPackages
        ? {
            averageBytes: this.root.documentPackages.averageBytes,
            load: (doc: number) =>
              reader.document(
                this.root.documentPackages!.generation,
                doc,
                this.documentDirectory?.lookup(doc),
              ),
          }
        : undefined);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isFinite(boost) ||
      boost < 0 ||
      boost > 20 ||
      !["all", "body", "title"].includes(field)
    )
      throw Error("Invalid search options");
    if (
      options.after &&
      (!Number.isFinite(options.after.score) ||
        !Number.isInteger(options.after.doc) ||
        options.after.doc < 0 ||
        options.after.doc >= this.root.count)
    )
      throw Error("Invalid search cursor");
    if (this.directory) {
      const result = await executePackets(
        ast,
        terms as Map<string, DirectoryTerm>,
        this.root,
        reader,
        options,
        packages,
      );
      if (result) return result;
    }
    const scoring = names
        .map((n, i) => (positive.has(n) ? i : -1))
        .filter((i) => i >= 0),
      required = mandatory(ast),
      anchor = [...required]
        .map((n) => terms.get(n)!)
        .sort((a, b) => a.df - b.df)[0];
    let bands: number[] = [],
      pairCandidates: Uint32Array | undefined,
      pairAnchor: Term | undefined,
      pairBatch: PairBatch | undefined,
      pairOffset = 0;
    const BAND = 4096;
    if (pairs) {
      if (
        pairs.root.baseGeneration !== this.root.generation ||
        pairs.root.count !== this.root.count
      )
        throw Error("Pair generation mismatch");
      const phrases = (n: Node): string[][] => {
        if (n.kind === "phrase") return [n.terms];
        if (!("left" in n)) return [];
        const a = phrases(n.left),
          b = phrases(n.right);
        if (n.kind === "or")
          return a.filter((x) =>
            b.some((y) => JSON.stringify(x) === JSON.stringify(y)),
          );
        if (n.kind === "except") return a;
        return [...a, ...b];
      };
      const names = phrases(ast).flatMap((ts) =>
          ts
            .slice(1)
            .map((b, i) => `@${terms.get(ts[i])?.id}:${terms.get(b)?.id}`),
        ),
        plans = await this.terms(names, pairs.reader, pairs.root);
      // A strategy memory budget, never a candidate limit: larger pairs fall
      // back to buffered positional intersection over the complete corpus.
      pairAnchor = [...plans.values()]
        .filter((p) => p.df <= 65536 && (!anchor || p.df < anchor.df))
        .sort((a, b) => a.df - b.df)[0];
      if (pairAnchor) {
        const bs = await leaves(
            pairs.reader,
            pairAnchor.tree,
            0,
            this.root.count,
          ),
          docs = new Uint32Array(pairAnchor.df),
          body = new Uint32Array(pairAnchor.df),
          title = new Uint32Array(pairAnchor.df),
          handles = new Uint32Array(pairAnchor.df);
        let n = 0;
        for (let i = 0; i < bs.length; i += 64) {
          const raw = await pairs.reader.many(
            bs.slice(i, i + 64).map((b) => b.score),
          );
          raw.forEach((b, j) => {
            const s = pairs.reader.decoded(bs[i + j].score, b, decodeScores);
            for (let r = 0; r < s.docs.length; r++)
              if (field === "all" || s[field][r]) {
                docs[n] = s.docs[r];
                body[n] = s.body[r];
                title[n] = s.title[r];
                handles[n] = ((i + j) << 8) | r;
                n++;
              }
          });
        }
        pairCandidates = docs.subarray(0, n);
        pairBatch = {
          docs: pairCandidates,
          body: body.subarray(0, n),
          title: title.subarray(0, n),
          handles: handles.subarray(0, n),
          branches: bs,
        };
        const selectedBands = new Set<number>();
        for (const d of pairCandidates) selectedBands.add(Math.floor(d / BAND));
        bands = [...selectedBands];
        if (ast.kind === "phrase")
          pairOffset = ast.terms
            .slice(1)
            .findIndex(
              (t, i) =>
                plans.get(
                  `@${terms.get(ast.terms[i])!.id}:${terms.get(t)!.id}`,
                ) === pairAnchor,
            );
      }
    }
    if (
      !pairCandidates &&
      ast.kind !== "empty" &&
      anchor &&
      anchor.df < this.root.count / 16
    ) {
      const selected = new Set<number>();
      const selectedDocs =
        anchor.df <= 65536 ? new Uint32Array(anchor.df) : undefined;
      let selectedCount = 0;
      let batch: Branch[] = [];
      // Bounded chunks, even for a large corpus; never materialize all plans of a common term.
      const flush = async () => {
        const scores = await Promise.all(
          batch.map((b) => reader.load(b.score, decodeScores)),
        );
        for (const s of scores)
          for (let r = 0; r < s.docs.length; r++)
            if (field === "all" || s[field][r]) {
              selected.add(Math.floor(s.docs[r] / BAND));
              if (selectedDocs) selectedDocs[selectedCount++] = s.docs[r];
            }
        batch = [];
      };
      for await (const leaf of leafStream(reader, anchor.tree)) {
        batch.push(leaf);
        if (batch.length === 64) await flush();
      }
      if (batch.length) await flush();
      if (selectedDocs)
        pairCandidates = selectedDocs.subarray(0, selectedCount);
      bands = [...selected].sort((a, b) => a - b);
    } else if (!pairCandidates && ast.kind !== "empty")
      bands = Array.from(
        { length: Math.ceil(this.root.count / BAND) },
        (_, i) => i,
      );
    let total = 0;
    for (const band of bands) {
      const lo = band * BAND,
        hi = Math.min(this.root.count, lo + BAND),
        size = hi - lo;
      const blocks = await Promise.all(
        names.map((n) => leaves(reader, terms.get(n)!.tree, lo, hi)),
      );
      if (coarse(ast, (n) => (blocks[names.indexOf(n)].length ? 2 : 0)) === 0) {
        reader.stats.skippedRanges++;
        continue;
      }
      const bounds = blocks.map((bs) => {
        let b = 0,
          t = 0;
        for (const x of bs) {
          b = Math.max(b, x.b);
          t = Math.max(t, x.t);
        }
        return (field !== "title" ? b : 0) + (field !== "body" ? boost * t : 0);
      });
      // Round the sum outward: equality is always visited, preserving deterministic ties.
      const upper =
        scoring.reduce((s, j) => s + bounds[j], 0) * (1 + Number.EPSILON * 32);
      if (
        !options.exactTotal &&
        heap.threshold &&
        (upper < heap.threshold.score ||
          (upper === heap.threshold.score && lo > heap.threshold.doc))
      ) {
        reader.stats.skippedRanges++;
        continue;
      }
      const cells = new Uint8Array(Math.ceil(size / 128)).fill(1);
      let candidateMask: Uint8Array | undefined;
      if (pairCandidates) {
        candidateMask = new Uint8Array(size);
        cells.fill(0);
        for (
          let i = lower(pairCandidates, lo);
          i < pairCandidates.length && pairCandidates[i] < hi;
          i++
        ) {
          cells[(pairCandidates[i] - lo) >>> 7] = 1;
          candidateMask[pairCandidates[i] - lo] = 1;
        }
      }
      if (!options.exactTotal && heap.threshold) {
        const threshold = heap.threshold;
        for (let cell = 0; cell < cells.length; cell++) {
          const from = lo + cell * 128,
            to = Math.min(hi, from + 128);
          let bound = 0;
          for (const j of scoring) {
            let b = 0,
              t = 0;
            for (const x of blocks[j])
              if (x.last >= from && x.first < to) {
                b = Math.max(b, x.b);
                t = Math.max(t, x.t);
              }
            bound +=
              (field !== "title" ? b : 0) + (field !== "body" ? boost * t : 0);
          }
          bound *= 1 + Number.EPSILON * 32;
          if (
            bound < threshold.score ||
            (bound === threshold.score && from > threshold.doc)
          )
            cells[cell] = 0;
        }
      }
      if (pairCandidates || heap.threshold) {
        for (let j = 0; j < blocks.length; j++)
          blocks[j] = blocks[j].filter((b) => {
            const first = Math.max(0, Math.floor((b.first - lo) / 128)),
              last = Math.min(
                cells.length - 1,
                Math.floor((b.last - lo) / 128),
              );
            for (let c = first; c <= last; c++) if (cells[c]) return true;
            return false;
          });
      }
      reader.stats.stages++;
      const data = await Promise.all(
        blocks.flatMap((bs) =>
          bs.map((b) => reader.load(b.score, decodeScores)),
        ),
      );
      let p = 0;
      const columns = blocks.map((bs) => {
        const decoded = bs.map(() => data[p++]);
        const length = decoded.reduce((s, d) => s + d.docs.length, 0),
          docs = new Uint32Array(length),
          body = new Uint32Array(length),
          title = new Uint32Array(length),
          handle = new Uint32Array(size),
          blockIndex = new Uint32Array(length),
          blockRow = new Uint8Array(length),
          b = new Float64Array(size),
          t = new Float64Array(size);
        let start = 0;
        decoded.forEach((s, j) => {
          reader.stats.postings += s.docs.length;
          docs.set(s.docs, start);
          body.set(s.body, start);
          title.set(s.title, start);
          for (let r = 0; r < s.docs.length; r++) {
            const d = s.docs[r];
            blockIndex[start + r] = j;
            blockRow[start + r] = r;
            if (d >= lo && d < hi) {
              handle[d - lo] = start + r + 1;
              b[d - lo] = s.b.getFloat64(r * 8, true);
              t[d - lo] = s.t.getFloat64(r * 8, true);
            }
          }
          start += s.docs.length;
        });
        return { docs, body, title, handle, blockIndex, blockRow, b, t };
      });
      const nameIndex = new Map(names.map((n, i) => [n, i])),
        present = (j: number, d: number) => {
          const c = columns[j],
            r = c.handle[d];
          return r && (field === "all" || c[field][r - 1]) ? 1 : 0;
        };
      const predicate = compileCoarse(ast, nameIndex, present);
      const candidates = new Uint32Array(size),
        values = new Float64Array(size);
      let nc = 0;
      for (let d = 0; d < size; d++) {
        if (!cells[d >>> 7]) continue;
        if (candidateMask && !candidateMask[d]) continue;
        if (predicate(d) === 0) continue;
        reader.stats.candidates++;
        let score = 0,
          remaining = upper;
        // Batched block-max MAXSCORE: a safe partial-score bound can reject a
        // candidate before remaining numeric contributions/positions are read.
        let rejected = false;
        for (const j of scoring) {
          const c = columns[j];
          score +=
            (field !== "title" ? c.b[d] : 0) +
            (field !== "body" ? boost * c.t[d] : 0);
          remaining = Math.max(0, remaining - bounds[j]);
          if (
            !options.exactTotal &&
            heap.threshold &&
            (score + remaining) * (1 + Number.EPSILON * 64) <
              heap.threshold.score
          ) {
            rejected = true;
            break;
          }
        }
        if (rejected) continue;
        const doc = d + lo;
        if (
          options.after &&
          (score > options.after.score ||
            (score === options.after.score && doc <= options.after.doc))
        )
          continue;
        if (!options.exactTotal && !heap.accepts(doc, score)) continue;
        candidates[nc] = doc;
        values[nc++] = score;
      }
      const positionData = new Map<string, Uint8Array>();
      // Very sparse phrases use compact forward IDs. Broad phrases/proximity
      // retain the buffered positional path and avoid per-document forward I/O.
      const forward =
        ast.kind === "phrase" &&
        field !== "title" &&
        pairBatch &&
        pairs &&
        pairBatch.docs.length <= 128 &&
        nc
          ? await verifyForward(
              reader,
              pairs.reader,
              pairBatch,
              candidates.subarray(0, nc),
              ast.terms.map((t) => terms.get(t)!.id),
              pairOffset,
            )
          : undefined;
      const loadPositions = async (from: number, to: number) => {
        positionData.clear();
        const refs = new Map<string, Ref>();
        for (const n of wantedPositions) {
          const j = nameIndex.get(n);
          if (j === undefined) continue;
          const c = columns[j];
          for (let i = from; i < to; i++) {
            if (
              (forward && forward[i] !== -2) ||
              (!options.exactTotal && !heap.accepts(candidates[i], values[i]))
            )
              continue;
            const row = c.handle[candidates[i] - lo] - 1;
            if (row >= 0) {
              const ref = blocks[j][c.blockIndex[row]].positions;
              refs.set(reader.key(ref), ref);
            }
          }
        }
        const raw = await reader.many([...refs.values()]);
        let i = 0;
        for (const key of refs.keys()) positionData.set(key, raw[i++]);
      };
      const scratch = names.map(() => ({
        doc: -1,
        fields: [undefined, undefined] as (Uint32Array | undefined)[],
      }));
      const direct = (name: string, doc: number, f: number) => {
        const j = nameIndex.get(name);
        if (j === undefined) return;
        const c = columns[j],
          row = c.handle[doc - lo] - 1;
        if (row < 0) return;
        const s = scratch[j];
        if (s.doc !== doc) {
          s.fields[0] = s.fields[1] = undefined;
          s.doc = doc;
        }
        if (!s.fields[f]) {
          const ref = blocks[j][c.blockIndex[row]].positions,
            raw = positionData.get(reader.key(ref));
          if (!raw) return;
          const v = view(raw),
            n = v.getUint32(0, true),
            r = c.blockRow[row],
            base = 4 + (n + 1) * 4,
            from = base + v.getUint32(4 + r * 4, true),
            end = base + v.getUint32(8 + r * 4, true),
            bl = v.getUint32(from, true);
          const start = f === 0 ? from + 4 : from + 4 + bl,
            stop = f === 0 ? from + 4 + bl : end;
          s.fields[f] = unpack(raw.subarray(start, stop));
          reader.stats.positionIntegers += s.fields[f]!.length;
          reader.stats.decodedBytes += stop - start;
        }
        return s.fields[f];
      };
      const lists = new Map<string, DecodedPostings>(
        names.map((n, j) => [
          n,
          {
            docs: columns[j].docs,
            body: columns[j].body,
            title: columns[j].title,
            bytes: new Uint8Array(0),
          },
        ]),
      );
      const match = positions
        ? positionalMatcher(ast, lists, field, direct, {
            spans: 262144,
            scratchSpans: 1048576,
            checks: 100000000,
          })
        : undefined;
      for (let i = 0; i < nc; i++) {
        if (positions && i % 256 === 0)
          await loadPositions(i, Math.min(nc, i + 256));
        const doc = candidates[i],
          score = values[i];
        if (!options.exactTotal && !heap.accepts(doc, score)) continue;
        if (forward && forward[i] === -1) continue;
        if (match && (!forward || forward[i] === -2) && !match(doc)) continue;
        total++;
        if (!heap.accepts(doc, score)) continue;
        let selected = -1;
        for (const j of scoring) {
          const c = columns[j],
            r = c.handle[doc - lo] - 1;
          if (r >= 0 && c.body[r]) {
            selected = j;
            break;
          }
        }
        const hasScoringBody = selected >= 0;
        if (selected < 0)
          selected = columns.findIndex((c) => !!c.handle[doc - lo]);
        const c = columns[selected],
          r = c ? c.handle[doc - lo] - 1 : -1;
        let first: number | undefined =
          forward && forward[i] >= 0 ? forward[i] : undefined;
        if (
          first === undefined &&
          match &&
          field !== "title" &&
          options.snippets !== false
        ) {
          if (ast.kind === "phrase") {
            const ps = ast.terms.map((n) => direct(n, doc, 0) ?? []);
            let anchor = 0;
            for (let j = 1; j < ps.length; j++)
              if (ps[j].length < ps[anchor].length) anchor = j;
            for (let j = 0; j < ps[anchor].length; j++) {
              const start = ps[anchor][j] - anchor;
              if (
                start >= 0 &&
                ps.every((a, k) => a[lower(a, start + k)] === start + k)
              ) {
                first = start;
                break;
              }
            }
          } else {
            try {
              first = match.firstBodySpan(doc)?.start;
            } catch (e) {
              if (!(e instanceof QueryResourceError)) throw e;
            }
          }
        }
        heap.add({
          doc,
          score,
          branch: r >= 0 ? blocks[selected][c.blockIndex[r]] : undefined,
          row: r >= 0 ? c.blockRow[r] : doc % 4096,
          first,
          titleOnly:
            field === "title" ||
            (ast.kind === "phrase" && first === undefined) ||
            (scoring.length > 0 && !hasScoringBody),
        });
      }
      const active =
        columns.reduce(
          (s, c) =>
            s +
            c.docs.byteLength +
            c.body.byteLength +
            c.title.byteLength +
            c.handle.byteLength +
            c.blockIndex.byteLength +
            c.blockRow.byteLength +
            c.b.byteLength +
            c.t.byteLength,
          0,
        ) +
        candidates.byteLength +
        values.byteLength +
        [...positionData.values()].reduce((s, b) => s + b.length, 0);
      reader.stats.peakActiveBufferBytes = Math.max(
        reader.stats.peakActiveBufferBytes,
        active,
      );
    }
    const ranked = heap.values.sort(
        (a, b) => b.score - a.score || a.doc - b.doc,
      ),
      display = performance.now(),
      resultRequests = reader.stats.requests,
      resultBytes = reader.stats.bytes,
      positiveIds = new Set([...positive].map((n) => terms.get(n)!.id)),
      results = packages
        ? await Promise.all(
            ranked.map(async (h) =>
              packageResult(
                await packages.load(h.doc),
                h,
                positiveIds,
                options,
              ),
            ),
          )
        : await renderResults(this.root, reader, ranked, options, ast);
    reader.stats.metadataMs = performance.now() - display;
    reader.stats.resultRequests = reader.stats.requests - resultRequests;
    reader.stats.resultBytes = reader.stats.bytes - resultBytes;
    return {
      results,
      ...(options.exactTotal ? { total } : {}),
      generation: this.root.generation,
      diagnostics: {
        ...reader.stats,
        pair: pairs
          ? {
              ...pairs.reader.stats,
              candidates: pairAnchor ? pairCandidates?.length : undefined,
              used: !!pairAnchor,
            }
          : undefined,
        executor: pairAnchor
          ? "positional-pair"
          : anchor && anchor.df < this.root.count / 16
            ? "selective"
            : "block-max-maxscore",
        wallMs: performance.now() - started,
        retainedPageBytes: reader.memory.pages.bytes,
        retainedDecodedBytes: reader.memory.decoded.bytes,
      },
    };
  }
}
