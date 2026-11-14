import { concat, u32, view, pack, unpack, type Ref } from "./format.js";
import { scanText } from "./construction/text.js";
import { encodeTextChunks, TextChunks } from "./text-chunks.js";
async function gzip(value: unknown) {
  return new Uint8Array(
    await new Response(
      new Response(JSON.stringify(value)).body!.pipeThrough(
        new CompressionStream("gzip"),
      ),
    ).arrayBuffer(),
  );
}
async function json(data: Uint8Array, inflated?: (bytes: number) => void) {
  const raw = await new Response(
    new Response(data as BodyInit).body!.pipeThrough(
      new DecompressionStream("gzip"),
    ),
  ).arrayBuffer();
  inflated?.(raw.byteLength);
  return JSON.parse(new TextDecoder().decode(raw));
}
export interface PackageDocument {
  doc: number;
  id: string;
  title?: string;
  metadata?: unknown;
  body: string;
}
/** One transfer, independently decoded sections. Display JSON and passage frames
 * remain compressed while a rejected candidate is verified and scored. */
export async function encodeDocumentPackage(
  document: PackageDocument,
  ids: Map<string, number>,
  analysis?: import("../query/analysis.js").Analysis,
) {
  const body = scanText(document.body, analysis),
    bodyIds: number[] = [],
    titleIds: number[] = [],
    starts: number[] = [],
    frequencies = new Map<number, [number, number]>();
  const add = (word: string, field: number) => {
    const id = ids.get(word);
    if (id === undefined)
      throw Error("Document package vocabulary missing a token");
    const f = frequencies.get(id) ?? [0, 0];
    f[field]++;
    frequencies.set(id, f);
    return id;
  };
  for (const t of body.tokens()) {
    bodyIds.push(add(t.word, 0));
    starts.push(t.start);
  }
  for (const t of scanText(document.title ?? "", analysis).tokens())
    titleIds.push(add(t.word, 1));
  const names = [...frequencies.keys()].sort((a, b) => a - b),
    stats = [
      pack(names, true),
      pack(names.map((id) => frequencies.get(id)![0])),
      pack(names.map((id) => frequencies.get(id)![1])),
    ],
    text = await encodeTextChunks(body.text, starts);
  const sections = [
      concat([u32(stats.map((b) => b.length)), ...stats]),
      pack(bodyIds),
      pack(titleIds),
      await gzip({
        id: document.id,
        title: document.title,
        metadata: document.metadata,
      }),
      text.directory,
      text.data,
    ],
    header = new Uint8Array(64),
    v = view(header);
  for (const [i, n] of [
    0x33504443,
    document.doc,
    bodyIds.length,
    titleIds.length,
  ].entries())
    v.setUint32(i * 4, n, true);
  let offset = 64;
  sections.forEach((s, i) => {
    v.setUint32(16 + i * 8, offset, true);
    v.setUint32(20 + i * 8, s.length, true);
    offset += s.length;
  });
  return concat([header, ...sections]);
}
export class DocumentPackage {
  readonly bodyLength: number;
  readonly titleLength: number;
  private body?: Uint32Array;
  private title?: Uint32Array;
  private stats?: { ids: Uint32Array; body: Uint32Array; title: Uint32Array };
  private record?: Promise<any>;
  /** Live binary/numeric storage; excludes transient matcher objects and text. */
  get numericBytes() {
    return (
      (this.body?.byteLength ?? 0) +
      (this.title?.byteLength ?? 0) +
      (this.stats
        ? this.stats.ids.byteLength +
          this.stats.body.byteLength +
          this.stats.title.byteLength
        : 0)
    );
  }
  readonly data: DataView;
  constructor(
    readonly bytes: Uint8Array,
    readonly doc: number,
    readonly observe?: (
      kind: "decoded" | "inflated" | "tokens",
      section: number,
      bytes: number,
    ) => void,
  ) {
    this.data = view(bytes);
    if (
      bytes.length < 64 ||
      this.data.getUint32(0, true) !== 0x33504443 ||
      this.data.getUint32(4, true) !== doc
    )
      throw Error("Invalid document package");
    this.bodyLength = this.data.getUint32(8, true);
    this.titleLength = this.data.getUint32(12, true);
    let end = 64;
    for (let i = 0; i < 6; i++) {
      const at = this.data.getUint32(16 + i * 8, true),
        n = this.data.getUint32(20 + i * 8, true);
      if (at !== end || at + n > bytes.length)
        throw Error("Invalid document section");
      end = at + n;
    }
    if (end !== bytes.length) throw Error("Trailing document package bytes");
  }
  private section(i: number) {
    const at = this.data.getUint32(16 + i * 8, true),
      n = this.data.getUint32(20 + i * 8, true);
    return this.bytes.subarray(at, at + n);
  }
  frequencies() {
    if (this.stats) return this.stats;
    const raw = this.section(0),
      v = view(raw);
    if (raw.length < 12) throw Error("Truncated document frequencies");
    const arrays: Uint32Array[] = [];
    let at = 12;
    for (let i = 0; i < 3; i++) {
      const n = v.getUint32(i * 4, true);
      arrays.push(unpack(raw.subarray(at, at + n)));
      at += n;
    }
    if (
      at !== raw.length ||
      arrays.some((a) => a.length !== arrays[0].length) ||
      arrays[0].some((n, i) => i > 0 && n <= arrays[0][i - 1])
    )
      throw Error("Invalid document frequencies");
    this.observe?.(
      "decoded",
      0,
      arrays.reduce((n, a) => n + a.byteLength, 0),
    );
    return (this.stats = { ids: arrays[0], body: arrays[1], title: arrays[2] });
  }
  tokens(field: number) {
    if (field === 0) {
      if (!this.body) {
        this.body = unpack(this.section(1));
        this.observe?.("decoded", 1, this.body.byteLength);
        this.observe?.("tokens", 1, this.body.length);
      }
      if (this.body.length !== this.bodyLength)
        throw Error("Body token count mismatch");
      return this.body;
    }
    if (field !== 1) throw Error("Invalid token field");
    if (!this.title) {
      this.title = unpack(this.section(2));
      this.observe?.("decoded", 2, this.title.byteLength);
      this.observe?.("tokens", 2, this.title.length);
    }
    if (this.title.length !== this.titleLength)
      throw Error("Title token count mismatch");
    return this.title;
  }
  positions(wanted: Set<number>, field: number) {
    const positions = new Map<number, number[]>(),
      tokens = this.tokens(field);
    for (let p = 0; p < tokens.length; p++)
      if (wanted.has(tokens[p])) {
        const a = positions.get(tokens[p]) ?? [];
        a.push(p);
        positions.set(tokens[p], a);
      }
    return positions;
  }
  async display() {
    return (this.record ??= json(this.section(3), (n) =>
      this.observe?.("inflated", 3, n),
    ));
  }
  private firstBodyToken(wanted: Set<number>) {
    if (!wanted.size) return undefined;
    if (this.body) {
      for (let p = 0; p < this.body.length; p++)
        if (wanted.has(this.body[p])) return p;
      return undefined;
    }
    // Rendering needs one occurrence, not an expanded whole-document token
    // array. Fixed-width packing permits a buffered scan with an early exit.
    const raw = this.section(1),
      v = view(raw);
    if (raw.length < 12) throw Error("Truncated body tokens");
    const n = v.getUint32(0, true),
      width = v.getUint8(8);
    if (
      n !== this.bodyLength ||
      width > 32 ||
      v.getUint8(9) !== 0 ||
      raw.length !== 12 + Math.ceil((n * width) / 32) * 4
    )
      throw Error("Invalid body token column");
    const mask = width === 32 ? 0xffffffff : 2 ** width - 1;
    for (let p = 0; p < n; p++) {
      const bit = p * width,
        at = 12 + (bit >>> 5) * 4,
        shift = bit & 31;
      let id = width ? v.getUint32(at, true) >>> shift : 0;
      if (shift + width > 32) id |= v.getUint32(at + 4, true) << (32 - shift);
      if (wanted.has((id & mask) >>> 0)) {
        this.observe?.("tokens", 1, p + 1);
        return p;
      }
    }
    this.observe?.("tokens", 1, n);
    return undefined;
  }
  async snippet(wanted: Set<number>, first?: number, titleOnly = false) {
    if (titleOnly)
      return String((await this.display()).title ?? "").slice(0, 400);
    if (first === undefined) first = this.firstBodyToken(wanted);
    return new TextChunks(this.section(4), this.section(5), (chunk, bytes) =>
      this.observe?.("inflated", 6 + chunk, bytes),
    ).snippet(first);
  }
}
