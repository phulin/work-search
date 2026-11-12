// Frozen CWS1 reader for builder verification only; not a production engine.
import { parse, queryTerms, positional, positionalTerms, simplify, type Node } from '../../../src/query/parser.js';
import { positionalMatcher, QueryResourceError } from '../../../src/query/evaluate.js';
import type { DecodedPostings } from '../../../src/format/codec.js';
import { type Root, type Term, type Branch, type Ref, type Scores, decodeScores, lower, refAt, view, unpack } from './format.js';
import { Reader } from './storage.js';
export interface Options { mode?: 'and' | 'or'; limit?: number; field?: 'all' | 'body' | 'title'; titleBoost?: number; after?: { score: number; doc: number }; metadata?: boolean; snippets?: boolean; exactTotal?: boolean }
interface Hit { doc: number; score: number; branch?: Branch; row: number; first?: number }
const better = (a: Hit, b: Hit) => a.score > b.score || (a.score === b.score && a.doc < b.doc);
class Heap {
  values: Hit[] = [];
  constructor(readonly k: number) {}
  get threshold() { return this.values.length === this.k ? this.values[0] : undefined; }
  accepts(doc: number, score: number) { const t = this.threshold; return !t || score > t.score || (score === t.score && doc < t.doc); }
  add(h: Hit) {
    const a = this.values; if (!this.accepts(h.doc, h.score)) return;
    if (a.length < this.k) { a.push(h); let i = a.length - 1; while (i) { const p = (i - 1) >>> 1; if (!better(a[p], a[i])) break; [a[i], a[p]] = [a[p], a[i]]; i = p; } }
    else { a[0] = h; let i = 0; while (i * 2 + 1 < a.length) { let c = i * 2 + 1; if (c + 1 < a.length && better(a[c], a[c + 1])) c++; if (!better(a[i], a[c])) break; [a[i], a[c]] = [a[c], a[i]]; i = c; } }
  }
}
/** Three-valued predicate: 0=false, 1=true, 2=unknown. Negated positional
 * conditions cannot be decided from frequencies, including double negation. */
export function coarse(ast: Node, present: (term: string) => number): number {
  const and = (a: number, b: number) => a === 0 || b === 0 ? 0 : a === 1 && b === 1 ? 1 : 2;
  if (ast.kind === 'empty') return 0; if (ast.kind === 'all') return 1;
  if (ast.kind === 'term') return present(ast.term);
  if (ast.kind === 'phrase') return ast.terms.some(t => present(t) === 0) ? 0 : 2;
  if (ast.kind === 'not') { const a = coarse(ast.child, present); return a === 2 ? 2 : 1 - a; }
  const a = coarse(ast.left, present), b = coarse(ast.right, present);
  if (ast.kind === 'or') return a === 1 || b === 1 ? 1 : a === 0 && b === 0 ? 0 : 2;
  if (ast.kind === 'except') return and(a, b === 2 ? 2 : 1 - b);
  const c = and(a, b); return ast.kind === 'near' && c !== 0 ? 2 : c;
}
function mandatory(ast: Node): Set<string> {
  if (ast.kind === 'term') return new Set([ast.term]);
  if (ast.kind === 'phrase') return new Set(ast.terms);
  if (!('left' in ast)) return new Set();
  const a = mandatory(ast.left), b = mandatory(ast.right);
  if (ast.kind === 'or') return new Set([...a].filter(t => b.has(t)));
  if (ast.kind === 'except') return a;
  return new Set([...a, ...b]);
}
async function leaves(reader: Reader, branch: Branch, lo: number, hi: number): Promise<Branch[]> {
  if (branch.last < lo || branch.first >= hi) return [];
  if (!branch.height) return [branch];
  const children = await reader.branches(branch.score);
  return (await Promise.all(children.filter(b => b.last >= lo && b.first < hi).map(b => leaves(reader, b, lo, hi)))).flat();
}
export class ColumnarIndex {
  constructor(readonly root: Root) {
    if (root.format !== 'CWS1' || !/^[a-f0-9]{64}$/.test(root.generation) || !root.count || root.documents.length !== Math.ceil(root.count / 4096)) throw Error('Invalid CWS1 root');
  }
  async terms(names: string[], reader: Reader) {
    const terms = new Map<string, Term>();
    const routes = new Map<number, string[]>();
    for (const name of names) {
      const hot = this.root.hot[name]; if (hot) { terms.set(name, hot); continue; }
      const ds = this.root.dictionaries; let l = 0, r = ds.length;
      while (l < r) { const m = (l + r) >>> 1; if (ds[m].last < name) l = m + 1; else r = m; }
      if (l < ds.length && ds[l].first <= name) { const a = routes.get(l) ?? []; a.push(name); routes.set(l, a); }
    }
    if (routes.size) reader.stats.stages++;
    await Promise.all([...routes].map(async ([i, names]) => {
      const ref = this.root.dictionaries[i].ref;
      const entries = reader.decoded(ref, await reader.read(ref), b => new Map<string, Term>(JSON.parse(new TextDecoder().decode(b))), ref[2] * 3);
      for (const name of names) { const term = entries.get(name); if (term) terms.set(name, term); }
    })); return terms;
  }
  async search(q: string, reader: Reader, options: Options = {}) {
    const started = performance.now(), original = parse(q, options.mode), terms = await this.terms(queryTerms(original), reader),
      ast = simplify(original, t => terms.has(t)), names = queryTerms(ast), positive = new Set(queryTerms(ast, true)), positions = positional(ast), wantedPositions = positionalTerms(ast),
      limit = options.limit ?? 20, boost = options.titleBoost ?? 2, field = options.field ?? 'all', heap = new Heap(limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isFinite(boost) || boost < 0 || boost > 20 || !['all','body','title'].includes(field)) throw Error('Invalid search options');
    if (options.after && (!Number.isFinite(options.after.score) || !Number.isInteger(options.after.doc) || options.after.doc < 0 || options.after.doc >= this.root.count)) throw Error('Invalid search cursor');
    const scoring = names.map((n, i) => positive.has(n) ? i : -1).filter(i => i >= 0), required = mandatory(ast),
      anchor = [...required].map(n => terms.get(n)!).sort((a, b) => a.df - b.df)[0];
    let bands: number[] = []; const BAND = 4096;
    if (ast.kind !== 'empty' && anchor && anchor.df < this.root.count / 16) {
      const blocks = await leaves(reader, anchor.tree, 0, this.root.count), selected = new Set<number>();
      // Bounded chunks, even for a large corpus; never materialize all plans of a common term.
      for (let i = 0; i < blocks.length; i += 64) {
        const data = await reader.many(blocks.slice(i, i + 64).map(b => b.score));
        data.forEach((b, j) => { const s = reader.decoded(blocks[i + j].score, b, decodeScores); for (let r = 0; r < s.docs.length; r++) if (field === 'all' || s[field][r]) selected.add(Math.floor(s.docs[r] / BAND)); });
      } bands = [...selected].sort((a, b) => a - b);
    } else if (ast.kind !== 'empty') bands = Array.from({ length: Math.ceil(this.root.count / BAND) }, (_, i) => i);
    let total = 0;
    for (const band of bands) {
      const lo = band * BAND, hi = Math.min(this.root.count, lo + BAND), size = hi - lo;
      const blocks = await Promise.all(names.map(n => leaves(reader, terms.get(n)!.tree, lo, hi)));
      if (coarse(ast, n => blocks[names.indexOf(n)].length ? 2 : 0) === 0) { reader.stats.skippedRanges++; continue; }
      const bounds = blocks.map(bs => {
        let b = 0, t = 0; for (const x of bs) { b = Math.max(b, x.b); t = Math.max(t, x.t); }
        return (field !== 'title' ? b : 0) + (field !== 'body' ? boost * t : 0);
      });
      // Round the sum outward: equality is always visited, preserving deterministic ties.
      const upper = scoring.reduce((s, j) => s + bounds[j], 0) * (1 + Number.EPSILON * 32);
      if (!options.exactTotal && heap.threshold && upper < heap.threshold.score) { reader.stats.skippedRanges++; continue; }
      const data = await reader.many(blocks.flatMap(bs => bs.map(b => b.score))); let p = 0;
      const columns = blocks.map(bs => {
        const decoded = bs.map(b => reader.decoded(b.score, data[p++], decodeScores));
        const length = decoded.reduce((s, d) => s + d.docs.length, 0), docs = new Uint32Array(length), body = new Uint32Array(length), title = new Uint32Array(length), handle = new Uint32Array(size), blockIndex = new Uint32Array(length), blockRow = new Uint8Array(length), b = new Float64Array(size), t = new Float64Array(size);
        let start = 0;
        decoded.forEach((s, j) => {
          reader.stats.postings += s.docs.length; docs.set(s.docs, start); body.set(s.body, start); title.set(s.title, start);
          for (let r = 0; r < s.docs.length; r++) { const d = s.docs[r]; blockIndex[start + r] = j; blockRow[start + r] = r; if (d >= lo && d < hi) { handle[d - lo] = start + r + 1; b[d - lo] = s.b.getFloat64(r * 8, true); t[d - lo] = s.t.getFloat64(r * 8, true); } }
          start += s.docs.length;
        }); return { docs, body, title, handle, blockIndex, blockRow, b, t };
      });
      const nameIndex = new Map(names.map((n, i) => [n, i])), present = (j: number, d: number) => { const c = columns[j], r = c.handle[d]; return r && (field === 'all' || c[field][r - 1]) ? 1 : 0; };
      const candidates = new Uint32Array(size), values = new Float64Array(size); let nc = 0;
      for (let d = 0; d < size; d++) {
        if (coarse(ast, n => present(nameIndex.get(n)!, d)) === 0) continue;
        reader.stats.candidates++;
        let score = 0, remaining = upper;
        // Batched block-max MAXSCORE: a safe partial-score bound can reject a
        // candidate before remaining numeric contributions/positions are read.
        let rejected = false;
        for (const j of scoring) {
          const c = columns[j]; score += (field !== 'title' ? c.b[d] : 0) + (field !== 'body' ? boost * c.t[d] : 0);
          remaining = Math.max(0, remaining - bounds[j]);
          if (!options.exactTotal && heap.threshold && (score + remaining) * (1 + Number.EPSILON * 64) < heap.threshold.score) { rejected = true; break; }
        }
        if (rejected) continue;
        const doc = d + lo;
        if (options.after && (score > options.after.score || (score === options.after.score && doc <= options.after.doc))) continue;
        if (!options.exactTotal && !heap.accepts(doc, score)) continue;
        candidates[nc] = doc; values[nc++] = score;
      }
      const positionData = new Map<string, Uint8Array>();
      if (positions && nc) {
        const refs = new Map<string, Ref>();
        for (const n of wantedPositions) {
          const j = nameIndex.get(n); if (j === undefined) continue;
          const c = columns[j]; for (let i = 0; i < nc; i++) { const row = c.handle[candidates[i] - lo] - 1; if (row >= 0) { const ref = blocks[j][c.blockIndex[row]].positions; refs.set(reader.key(ref), ref); } }
        }
        const raw = await reader.many([...refs.values()]); let i = 0; for (const key of refs.keys()) positionData.set(key, raw[i++]);
      }
      const scratch = names.map(() => ({ doc: -1, b: new Uint32Array(0), t: new Uint32Array(0) }));
      const direct = (name: string, doc: number, f: number) => {
        const j = nameIndex.get(name); if (j === undefined) return;
        const c = columns[j], row = c.handle[doc - lo] - 1; if (row < 0) return;
        const s = scratch[j];
        if (s.doc !== doc) {
          const ref = blocks[j][c.blockIndex[row]].positions, raw = positionData.get(reader.key(ref)); if (!raw) return;
          const v = view(raw), n = v.getUint32(0, true), r = c.blockRow[row], base = 4 + (n + 1) * 4, from = base + v.getUint32(4 + r * 4, true), end = base + v.getUint32(8 + r * 4, true), bl = v.getUint32(from, true);
          s.b = unpack(raw.subarray(from + 4, from + 4 + bl)); s.t = unpack(raw.subarray(from + 4 + bl, end)); s.doc = doc; reader.stats.positionIntegers += s.b.length + s.t.length;
        } return f === 0 ? s.b : s.t;
      };
      const lists = new Map<string, DecodedPostings>(names.map((n, j) => [n, { docs: columns[j].docs, body: columns[j].body, title: columns[j].title, bytes: new Uint8Array(0) }]));
      const match = positions ? positionalMatcher(ast, lists, field, direct) : undefined;
      for (let i = 0; i < nc; i++) {
        const doc = candidates[i], score = values[i];
        if (!options.exactTotal && !heap.accepts(doc, score)) continue;
        if (match && !match(doc)) continue; total++;
        if (!heap.accepts(doc, score)) continue;
        let selected = -1;
        for (const j of scoring) { const c = columns[j], r = c.handle[doc - lo] - 1; if (r >= 0 && c.body[r]) { selected = j; break; } }
        if (selected < 0) selected = columns.findIndex(c => !!c.handle[doc - lo]);
        const c = columns[selected], r = c ? c.handle[doc - lo] - 1 : -1;
        let first: number | undefined;
        if (match && options.snippets !== false) {
          if (ast.kind === 'phrase') {
            const ps = ast.terms.map(n => direct(n, doc, 0) ?? []); let anchor = 0;
            for (let j = 1; j < ps.length; j++) if (ps[j].length < ps[anchor].length) anchor = j;
            for (let j = 0; j < ps[anchor].length; j++) { const start = ps[anchor][j] - anchor; if (start >= 0 && ps.every((a, k) => a[lower(a, start + k)] === start + k)) { first = start; break; } }
          } else {
            try { first = match.firstBodySpan(doc)?.start; } catch (e) { if (!(e instanceof QueryResourceError)) throw e; }
          }
        }
        heap.add({ doc, score, branch: r >= 0 ? blocks[selected][c.blockIndex[r]] : undefined, row: r >= 0 ? c.blockRow[r] : doc % 4096, first });
      }
      const active = columns.reduce((s, c) => s + c.docs.byteLength + c.body.byteLength + c.title.byteLength + c.handle.byteLength + c.blockIndex.byteLength + c.blockRow.byteLength + c.b.byteLength + c.t.byteLength, 0) + candidates.byteLength + values.byteLength + [...positionData.values()].reduce((s, b) => s + b.length, 0);
      reader.stats.peakActiveBufferBytes = Math.max(reader.stats.peakActiveBufferBytes, active);
    }
    const ranked = heap.values.sort((a, b) => b.score - a.score || a.doc - b.doc), displayStart = performance.now();
    const locators = await reader.many(ranked.map(h => h.branch?.locators ?? this.root.documents[Math.floor(h.doc / 4096)]));
    const results = await Promise.all(ranked.map(async (h, i) => {
      const v = view(locators[i]), p = h.row * 36, recordRef = refAt(v, p), forwardRef = refAt(v, p + 12);
      let snippetRef = refAt(v, p + 24);
      if (options.snippets !== false && h.first !== undefined) {
        const directory = view(await reader.read(forwardRef)), frame = Math.floor(h.first / 256);
        if ((frame + 1) * 32 > directory.byteLength) throw Error('Invalid forward frame');
        snippetRef = refAt(directory, frame * 32 + 20);
      }
      const [record, passage] = await Promise.all([reader.json(recordRef), options.snippets !== false ? reader.json(snippetRef) : undefined]);
      let snippet: string | undefined;
      if (passage) {
        let at = h.first === undefined ? -1 : h.first - passage.first;
        if (at < 0 || at >= passage.starts.length) { const ts = new Set(queryTerms(ast, true)); const m = passage.text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []; at = m.findIndex((t: string) => ts.has(t)); }
        const from = at >= 0 ? Math.max(0, passage.starts[at] - 160) : 0, end = at >= 0 ? passage.ends[at] + 240 : 400;
        snippet = (passage.first || from ? '…' : '') + passage.text.slice(from, end).trim() + (end < passage.text.length ? '…' : '');
      }
      return { id: record.id, doc: h.doc, score: h.score, ...(options.metadata !== false ? { title: record.title, metadata: record.metadata } : {}), ...(snippet !== undefined ? { snippet } : {}) };
    }));
    reader.stats.metadataMs = performance.now() - displayStart;
    return { results, ...(options.exactTotal ? { total } : {}), generation: this.root.generation, diagnostics: { ...reader.stats, executor: anchor && anchor.df < this.root.count / 16 ? 'selective' : 'block-max-maxscore', wallMs: performance.now() - started, retainedPageBytes: reader.memory.pages.bytes, retainedDecodedBytes: reader.memory.decoded.bytes } };
  }
}
