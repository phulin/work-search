import type { Node } from "../query/parser.js";
import { requiredTerms } from "../query/load.js";
import { tokenize } from "../query/tokenize.js";
import { QueryResourceError } from "../query/evaluate.js";
import { SearchRuntime } from "../query/runtime.js";
import { decoder } from "../format/codec.js";
import {
  CHUNK_TOKENS,
  decodeRows,
  type Address,
  type Row,
  type Term,
} from "./format.js";
import type { PageReader } from "./storage.js";
const key = (ref: Address) => ref.join(":");
export interface WindowPlan {
  anchor: string;
  radius: number;
  node: Node;
}
export interface TokenFrame {
  address: Address;
  first: number;
  text: string;
  starts: number[];
  ends: number[];
  terms: string[];
}
/** Maximum span width; unconstrained conjunctions cannot be verified in one bounded neighborhood. */
function width(n: Node): number | undefined {
  if (n.kind === "term") return 1;
  if (n.kind === "phrase") return n.terms.length;
  if (n.kind === "near" || n.kind === "or") {
    const a = width(n.left),
      b = width(n.right);
    if (a === undefined || b === undefined) return;
    return n.kind === "near" ? a + b + n.distance - 1 : Math.max(a, b);
  }
  return undefined;
}
export function planWindows(
  ast: Node,
  plans: Map<string, Term>,
  field: string,
): WindowPlan | undefined {
  if (field === "title") return;
  const nodes: Node[] = [];
  let negative = false;
  const containsPositions = (n: Node): boolean =>
    n.kind === "phrase" ||
    n.kind === "near" ||
    ("child" in n && containsPositions(n.child)) ||
    ("left" in n && (containsPositions(n.left) || containsPositions(n.right)));
  const visit = (n: Node): void => {
    if (n.kind === "phrase" || n.kind === "near") nodes.push(n);
    else if (n.kind === "not") negative ||= containsPositions(n.child);
    else if (n.kind === "except") {
      negative ||= containsPositions(n.right);
      visit(n.left);
    } else if ("left" in n) {
      visit(n.left);
      visit(n.right);
    }
  };
  visit(ast);
  if (negative || nodes.length !== 1) return;
  const span = width(nodes[0]);
  if (span === undefined || span <= 1 || span > 129) return;
  const required = requiredTerms(ast);
  const anchors = [...requiredTerms(nodes[0])].filter(
    (t) => required.has(t) && plans.get(t)?.df,
  );
  anchors.sort(
    (a, b) => plans.get(a)!.df - plans.get(b)!.df || (a < b ? -1 : 1),
  );
  if (!anchors.length) return;
  return { anchor: anchors[0], radius: span - 1, node: nodes[0] };
}
function frameRefs(
  row: Row,
  plan: WindowPlan,
  field: string,
): Address[] | undefined {
  if (!row.bp || !row.body || row.body > 8 || (field === "all" && row.title))
    return;
  const refs = new Map<string, Address>();
  for (const p of row.bp) {
    const chunk = Math.floor(p / CHUNK_TOKENS);
    // Artificial frame edges lose lowercase context. Trim one token at either edge.
    const first = Math.max(0, chunk * CHUNK_TOKENS - 24) + (chunk ? 1 : 0);
    const end = (chunk + 1) * CHUNK_TOKENS + 24 - 1;
    if (Math.max(0, p - plan.radius) < first || p + plan.radius >= end) return;
    const ref = row.chunks?.find(([i]) => i === chunk)?.[1];
    if (!ref) throw Error("Missing anchor token frame");
    refs.set(key(ref), ref);
    if (refs.size > 4) return;
  }
  return [...refs.values()];
}
function blockRef(term: Term, doc: number) {
  let lo = 0,
    hi = term.blocks.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (term.blocks[m].last < doc) lo = m + 1;
    else hi = m;
  }
  const b = term.blocks[lo];
  if (!b || b.first > doc) throw Error("Missing verification block");
  return b.positions;
}
export function frameExcerpt(
  p: TokenFrame,
  span: { start: number; end: number },
) {
  const i = span.start - p.first,
    j = span.end - p.first;
  const start = Math.max(0, p.starts[i] - 160),
    end = Math.min(p.text.length, p.ends[j] + 240);
  return (
    (p.first || start ? "…" : "") +
    p.text.slice(start, end).trim() +
    (end < p.text.length ? "…" : "")
  );
}
interface Candidate {
  doc: number;
  full: { term: string; ref: Address }[];
  frames?: Address[];
}
export class PositionVerifier {
  constructor(
    readonly reader: PageReader,
    readonly plans: Map<string, Term>,
    readonly cache: SearchRuntime,
    readonly window: WindowPlan | undefined,
    readonly field: string,
  ) {}
  private costs(refs: Map<string, { ref: Address; frame: boolean }>) {
    let raw = 0;
    const pages = new Set<string>();
    for (const [id, { ref, frame }] of refs) {
      if (!this.cache.peek((frame ? "window:" : "") + id)) raw += ref[4];
      for (
        let p = Math.floor(ref[1] / this.reader.root.pageBytes);
        p <= Math.floor((ref[1] + ref[2] - 1) / this.reader.root.pageBytes);
        p++
      )
        pages.add(ref[0] + ":" + p);
    }
    return { raw, physical: pages.size * this.reader.root.pageBytes };
  }
  async batch(
    byTerm: Map<string, Row[]>,
    docs: number[],
    maxDocs: number,
    maxRaw: number,
  ) {
    const maps = new Map(
      [...byTerm].map(([t, rs]) => [t, new Map(rs.map((r) => [r.doc, r]))]),
    );
    const selected: Candidate[] = [];
    let actual = new Map<string, { ref: Address; frame: boolean }>(),
      full = new Map<string, { ref: Address; frame: boolean }>();
    for (const doc of docs) {
      if (selected.length >= maxDocs) break;
      const c: Candidate = { doc, full: [] };
      for (const [term, rows] of maps) {
        const r = rows.get(doc);
        if (term !== "" && r && !r.bp)
          c.full.push({ term, ref: blockRef(this.plans.get(term)!, doc) });
      }
      const anchor = this.window && maps.get(this.window.anchor)?.get(doc);
      if (c.full.length && anchor)
        c.frames = frameRefs(anchor, this.window!, this.field);
      const nextFull = new Map(full),
        nextActual = new Map(actual);
      for (const { ref } of c.full)
        nextFull.set(key(ref), { ref, frame: false });
      if (c.frames)
        for (const ref of c.frames)
          nextActual.set(key(ref), { ref, frame: true });
      else
        for (const { ref } of c.full)
          nextActual.set(key(ref), { ref, frame: false });
      const a = this.costs(nextActual),
        b = this.costs(nextFull);
      if (
        Math.max(a.raw, b.raw) > maxRaw ||
        Math.max(a.physical, b.physical) > 16 * 1048576
      ) {
        if (!selected.length)
          throw new QueryResourceError(
            "One positional candidate exceeds memory budget",
          );
        break;
      }
      selected.push(c);
      full = nextFull;
      actual = nextActual;
    }
    const skipped = new Map(full);
    for (const [id, item] of actual) if (!item.frame) skipped.delete(id);
    const frames = new Map([...actual].filter(([, v]) => v.frame));
    // Avoid reading dozens of text frames when one shared position block is cheaper.
    if (
      frames.size &&
      (this.costs(frames).raw > this.costs(skipped).raw * 0.75 ||
        this.costs(frames).physical > this.costs(skipped).physical)
    ) {
      for (const c of selected) c.frames = undefined;
      actual = full;
    }
    const needed = new Map<
      string,
      { ref: Address; term: string; docs: Set<number> }
    >();
    const framePayloads = new Map<string, TokenFrame>();
    for (const c of selected) {
      if (c.frames)
        for (const ref of c.frames) {
          const cached = this.cache.get<TokenFrame>("window:" + key(ref));
          if (cached) framePayloads.set(key(ref), cached);
        }
      else
        for (const { ref, term } of c.full) {
          const id = key(ref);
          if (!needed.has(id)) needed.set(id, { ref, term, docs: new Set() });
          needed.get(id)!.docs.add(c.doc);
        }
    }
    const rawPositions = new Map<string, Uint8Array>();
    for (const id of needed.keys()) {
      const cached = this.cache.get<Uint8Array>(id);
      if (cached) rawPositions.set(id, cached);
    }
    const missing = [...actual].filter(([id, item]) =>
      item.frame ? !framePayloads.has(id) : !rawPositions.has(id),
    );
    const payloads = await this.reader.readMany(
      missing.map(([, v]) => v.ref),
      frames.size ? "candidate-windows-and-positions" : "candidate-positions",
    );
    let blocks = 0;
    for (let i = 0; i < missing.length; i++) {
      const [id, item] = missing[i],
        bytes = payloads[i];
      if (item.frame) {
        const p = JSON.parse(decoder.decode(bytes));
        const frame: TokenFrame = {
          ...p,
          address: item.ref,
          terms: tokenize(p.text),
        };
        framePayloads.set(id, frame);
        this.cache.set("window:" + id, frame, item.ref[4] * 6);
      } else {
        blocks++;
        rawPositions.set(id, bytes);
        this.cache.set(id, bytes, bytes.length);
      }
    }
    const positionRows = new Map<string, Map<number, Row>>();
    const attach = () => {
      for (const [id, n] of needed) {
        if (!positionRows.has(n.term)) positionRows.set(n.term, new Map());
        for (const r of decodeRows(rawPositions.get(id)!, n.docs))
          positionRows.get(n.term)!.set(r.doc, r);
      }
    };
    attach();
    const windows = new Map<number, TokenFrame[]>(),
      recovered = new Map<number, Map<string, number[]>>();
    const failed: Candidate[] = [];
    for (const c of selected) {
      if (!c.frames) continue;
      const ps = c.frames.map((ref) => framePayloads.get(key(ref))!);
      const positions = new Map<string, Set<number>>(
        [...byTerm.keys()].map((t) => [t, new Set()]),
      );
      let valid = true;
      for (const p of ps) {
        if (
          p.terms.length !== p.starts.length ||
          p.starts.length !== p.ends.length
        ) {
          valid = false;
          break;
        }
        const chunk = Math.floor((p.first + 24) / CHUNK_TOKENS),
          expectedEnd = (chunk + 1) * CHUNK_TOKENS + 24;
        for (
          let i = p.first ? 1 : 0;
          i <
          p.terms.length - (p.first + p.terms.length === expectedEnd ? 1 : 0);
          i++
        )
          positions.get(p.terms[i])?.add(p.first + i);
      }
      const anchor = maps.get(this.window!.anchor)!.get(c.doc)!;
      const found = positions.get(this.window!.anchor)!;
      if (
        found.size !== anchor.bp!.length ||
        anchor.bp!.some((p) => !found.has(p))
      )
        valid = false;
      for (const [term, rows] of maps)
        if ((positions.get(term)?.size ?? 0) > (rows.get(c.doc)?.body ?? 0))
          valid = false;
      if (!valid) {
        failed.push(c);
        continue;
      }
      recovered.set(
        c.doc,
        new Map(
          [...positions].map(([t, p]) => [t, [...p].sort((a, b) => a - b)]),
        ),
      );
      windows.set(c.doc, ps);
    }
    if (failed.length) {
      const extra = new Map<
        string,
        { ref: Address; term: string; docs: Set<number> }
      >();
      for (const c of failed)
        for (const { ref, term } of c.full) {
          const id = key(ref);
          if (!extra.has(id)) extra.set(id, { ref, term, docs: new Set() });
          extra.get(id)!.docs.add(c.doc);
        }
      const entries = [...extra],
        bytes = await this.reader.readMany(
          entries.map(([, n]) => n.ref),
          "window-fallback-positions",
        );
      entries.forEach(([id, n], i) => {
        rawPositions.set(id, bytes[i]);
        needed.set(id, n);
        this.cache.set(id, bytes[i], bytes[i].length);
      });
      blocks += entries.length;
      attach();
    }
    const result = new Map<string, Row[]>();
    for (const [term, rows] of maps) {
      const list: Row[] = [];
      for (const c of selected) {
        const row = rows.get(c.doc);
        if (!row) continue;
        if (recovered.has(c.doc))
          list.push({
            ...row,
            bp: recovered.get(c.doc)!.get(term) ?? [],
            tp: [],
            chunks: maps.get(this.window!.anchor)!.get(c.doc)!.chunks,
          });
        else {
          const p = row.bp ? row : positionRows.get(term)?.get(c.doc);
          if (
            term !== "" &&
            (!p || p.bp!.length !== row.body || p.tp!.length !== row.title)
          )
            throw Error("Frequency/position verification mismatch");
          list.push(term === "" ? row : { ...row, ...p });
        }
      }
      list.sort((a, b) => a.doc - b.doc);
      result.set(term, list);
    }
    return {
      rows: result,
      docs: selected.map((c) => c.doc),
      windows,
      positionBlocks: blocks,
      windowDocs: windows.size,
      windowFallbacks: failed.length,
    };
  }
}
