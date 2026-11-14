import { BLOCK, unpackColumn, view } from "./format.js";
import { contribution, type ScoreParameters } from "./scoring.js";
/** Numeric buffers live for one query and are reused across document bands.
 * Blocks decode straight into them: no copied block buffer, column slices,
 * temporary frequency arrays or cached per-block score objects. */
export class ScoreBatch {
  docs: Uint32Array;
  body: Uint32Array;
  title: Uint32Array;
  blockIndex: Uint32Array;
  blockRow: Uint8Array;
  handle: Uint32Array;
  b: Float64Array;
  t: Float64Array;
  count = 0;
  first = 0;
  size = 0;
  private bodyLengths = new Uint32Array(BLOCK);
  private titleLengths = new Uint32Array(BLOCK);
  constructor(
    readonly bandSize: number,
    readonly parameters: ScoreParameters,
  ) {
    const capacity = bandSize + BLOCK * 2;
    this.docs = new Uint32Array(capacity);
    this.body = new Uint32Array(capacity);
    this.title = new Uint32Array(capacity);
    this.blockIndex = new Uint32Array(capacity);
    this.blockRow = new Uint8Array(capacity);
    this.handle = new Uint32Array(bandSize);
    this.b = new Float64Array(bandSize);
    this.t = new Float64Array(bandSize);
  }
  reset(first: number, size: number) {
    if (size > this.bandSize) throw Error("Score band exceeds workspace");
    this.first = first;
    this.size = size;
    this.count = 0;
    this.handle.fill(0);
    this.b.fill(0);
    this.t.fill(0);
  }
  append(raw: Uint8Array, block: number) {
    if (raw.length < 36 || view(raw).getUint32(0, true) !== 0x34534343)
      throw Error("Invalid scoring block");
    const v = view(raw),
      n = v.getUint32(24, true),
      start = this.count;
    if (!n || n > BLOCK || start + n > this.docs.length)
      throw Error("Invalid scoring block count");
    let at = 24;
    for (let i = 0; i < 3; i++) {
      const length = v.getUint32(4 + i * 4, true),
        target = i === 0 ? this.docs : i === 1 ? this.body : this.title;
      if (!length && i) target.fill(0, start, start + n);
      else if (unpackColumn(v, at, length, target, start) !== n)
        throw Error("Invalid scoring columns");
      at += length;
    }
    for (let i = 0; i < 2; i++) {
      const length = v.getUint32(16 + i * 4, true),
        target = i ? this.titleLengths : this.bodyLengths;
      if (!length) target.fill(0, 0, n);
      else if (unpackColumn(v, at, length, target) !== n)
        throw Error("Invalid field length column");
      at += length;
    }
    if (at !== raw.length) throw Error("Invalid scoring columns");
    for (let row = 0; row < n; row++) {
      const index = start + row,
        doc = this.docs[index],
        d = doc - this.first;
      if (index && doc <= this.docs[index - 1])
        throw Error("Unsorted scoring documents");
      this.blockIndex[index] = block;
      this.blockRow[index] = row;
      if (
        this.body[index] > this.bodyLengths[row] ||
        this.title[index] > this.titleLengths[row]
      )
        throw Error("Invalid field length");
      if (d >= 0 && d < this.size) {
        this.handle[d] = index + 1;
        this.b[d] = contribution(
          this.body[index],
          this.bodyLengths[row],
          this.parameters.avgBody,
          this.parameters.idf,
        );
        this.t[d] = contribution(
          this.title[index],
          this.titleLengths[row],
          this.parameters.avgTitle,
          this.parameters.idf,
        );
      }
    }
    this.count += n;
    return n;
  }
  columns() {
    const n = this.count;
    return {
      docs: this.docs.subarray(0, n),
      body: this.body.subarray(0, n),
      title: this.title.subarray(0, n),
      blockIndex: this.blockIndex.subarray(0, n),
      blockRow: this.blockRow.subarray(0, n),
      handle: this.handle,
      b: this.b,
      t: this.t,
    };
  }
  get bytes() {
    return (
      this.docs.byteLength +
      this.body.byteLength +
      this.title.byteLength +
      this.blockIndex.byteLength +
      this.blockRow.byteLength +
      this.handle.byteLength +
      this.b.byteLength +
      this.t.byteLength +
      this.bodyLengths.byteLength +
      this.titleLengths.byteLength
    );
  }
}
