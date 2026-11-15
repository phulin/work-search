import { concat, pack, unpack, u32, view } from "../format.js";
import { BuildStore, type Chunk } from "./runs.js";
import { transformBlock } from "./block-codec.js";
import type { NumericDocument } from "./analyzed-document.js";
export interface NumericRun {
  version: 3;
  first: number;
  end: number;
  catalogue: string;
  chunks: Chunk[];
}
export function encodeNumeric(rows: NumericDocument[]) {
  const parts = [u32([0x334e4443, rows.length])];
  for (const row of rows) {
    const body = pack(row.body),
      title = pack(row.title);
    parts.push(u32([row.doc, body.length, title.length]), body, title);
  }
  return concat(parts);
}
export function* decodeNumeric(raw: Uint8Array): Generator<NumericDocument> {
  if (raw.length < 8 || view(raw).getUint32(0, true) !== 0x334e4443)
    throw Error("Invalid numeric staging version");
  const v = view(raw),
    count = v.getUint32(4, true);
  let p = 8,
    last = -1;
  for (let i = 0; i < count; i++) {
    if (p + 12 > raw.length) throw Error("Truncated numeric staging");
    const doc = v.getUint32(p, true),
      bn = v.getUint32(p + 4, true),
      tn = v.getUint32(p + 8, true);
    if ((doc !== last + 1 && last !== -1) || p + 12 + bn + tn > raw.length)
      throw Error("Numeric coverage/size mismatch");
    yield {
      doc,
      body: unpack(raw.subarray(p + 12, p + 12 + bn)),
      title: unpack(raw.subarray(p + 12 + bn, p + 12 + bn + tn)),
    };
    p += 12 + bn + tn;
    last = doc;
  }
  if (p !== raw.length) throw Error("Trailing numeric staging bytes");
}
/** No word is dropped: adjacency and the previous/next token identities survive
 * candidate-vocabulary selection. This lane contains no display bytes. */
export class NumericWriter {
  private rows: NumericDocument[] = [];
  private tokens = 0;
  private parts: Uint8Array[] = [];
  private bytes = 0;
  private chunks: Chunk[] = [];
  private next: number;
  constructor(
    readonly store: BuildStore,
    readonly first: number,
    readonly catalogue: string,
    readonly tokenBudget = 131072,
    readonly containerBytes = 4 * 1048576,
  ) {
    this.next = first;
  }
  async append(row: NumericDocument) {
    if (row.doc !== this.next++) throw Error("Numeric staging coverage gap");
    this.rows.push(row);
    this.tokens += row.body.length + row.title.length;
    if (this.tokens >= this.tokenBudget) await this.flushBlock();
  }
  private async flushBlock() {
    if (!this.rows.length) return;
    const raw = await transformBlock(encodeNumeric(this.rows));
    if (this.bytes && this.bytes + raw.length > this.containerBytes)
      await this.flushContainer();
    this.parts.push(raw);
    this.bytes += raw.length;
    this.rows = [];
    this.tokens = 0;
  }
  private async flushContainer() {
    this.chunks.push(...(await this.store.putParts(this.parts)));
    this.parts = [];
    this.bytes = 0;
  }
  async finish(): Promise<NumericRun> {
    await this.flushBlock();
    await this.flushContainer();
    return {
      version: 3,
      first: this.first,
      end: this.next,
      catalogue: this.catalogue,
      chunks: this.chunks,
    };
  }
}
export async function* numericDocuments(
  store: BuildStore,
  run: NumericRun,
  catalogue: string,
) {
  if (run.version !== 3 || run.catalogue !== catalogue)
    throw Error("Numeric staging catalogue mismatch");
  let next = run.first;
  for (let at = 0; at < run.chunks.length;) {
    let end = at + 1,
      bytes = run.chunks[at].size;
    while (
      end < run.chunks.length &&
      bytes + run.chunks[end].size <= 4 * 1048576
    )
      bytes += run.chunks[end++].size;
    const blocks = await store.getMany(run.chunks.slice(at, end));
    for (const block of blocks)
      for (const row of decodeNumeric(await transformBlock(block, true))) {
        if (row.doc !== next++) throw Error("Numeric staging coverage gap");
        yield row;
      }
    at = end;
  }
  if (next !== run.end) throw Error("Incomplete numeric staging");
}
