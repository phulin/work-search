const MAGIC = 0x31495357,
  HEADER = 48,
  RECORD = 24;
export interface PhraseInterval {
  words: number[];
  first: number;
  end: number;
}
const compare = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
const identity = (generation: string) => {
  if (!/^[a-f0-9]{64}$/.test(generation))
    throw Error("Invalid suffix interval identity");
  return Uint8Array.from({ length: 32 }, (_, i) =>
    parseInt(generation.slice(i * 2, i * 2 + 2), 16),
  );
};
export function encodePhraseIntervals(
  records: PhraseInterval[],
  corpus: string,
  rows: number,
) {
  const sorted = records.slice().sort((a, b) => compare(a.words, b.words)),
    raw = new Uint8Array(HEADER + sorted.length * RECORD),
    v = new DataView(raw.buffer);
  v.setUint32(0, MAGIC, true);
  v.setUint32(4, sorted.length, true);
  v.setUint32(8, rows, true);
  raw.set(identity(corpus), 16);
  sorted.forEach((r, i) => {
    if (
      r.words.length < 2 ||
      r.words.length > 5 ||
      !Number.isInteger(r.first) ||
      !Number.isInteger(r.end) ||
      r.first < 0 ||
      r.end <= r.first ||
      r.end > rows ||
      r.words.some((w) => !Number.isInteger(w) || w < 1 || w > 0xffffff) ||
      (i && compare(sorted[i - 1].words, r.words) === 0)
    )
      throw Error("Invalid suffix phrase interval");
    const at = HEADER + i * RECORD;
    v.setUint8(at, r.words.length);
    r.words.forEach((w, j) => {
      v.setUint16(at + 1 + j * 3, w & 65535, true);
      v.setUint8(at + 3 + j * 3, w >>> 16);
    });
    v.setUint32(at + 16, r.first, true);
    v.setUint32(at + 20, r.end, true);
  });
  return raw;
}
export class PhraseIntervals {
  private view: DataView;
  readonly count: number;
  constructor(
    readonly bytes: Uint8Array,
    corpus: string,
    rows: number,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      bytes.length < HEADER ||
      this.view.getUint32(0, true) !== MAGIC ||
      this.view.getUint32(8, true) !== rows ||
      identity(corpus).some((b, i) => b !== bytes[16 + i])
    )
      throw Error("Invalid suffix phrase intervals");
    this.count = this.view.getUint32(4, true);
    if (bytes.length !== HEADER + this.count * RECORD)
      throw Error("Truncated suffix phrase intervals");
  }
  lookup(words: Uint32Array) {
    if (words.length < 2 || words.length > 5) return;
    let lo = 0,
      hi = this.count;
    const cmp = (i: number) => {
      const at = HEADER + i * RECORD,
        n = this.view.getUint8(at);
      for (let j = 0; j < Math.min(n, words.length); j++) {
        const w =
          this.view.getUint16(at + 1 + j * 3, true) +
          this.view.getUint8(at + 3 + j * 3) * 65536;
        if (w !== words[j]) return w - words[j];
      }
      return n - words.length;
    };
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cmp(mid) < 0) lo = mid + 1;
      else hi = mid;
    }
    if (lo === this.count || cmp(lo) !== 0) return;
    const at = HEADER + lo * RECORD;
    return {
      first: this.view.getUint32(at + 16, true),
      end: this.view.getUint32(at + 20, true),
    };
  }
  *entries(): Generator<PhraseInterval> {
    for (let i = 0; i < this.count; i++) {
      const at = HEADER + i * RECORD,
        length = this.view.getUint8(at),
        words = Array.from(
          { length },
          (_, j) =>
            this.view.getUint16(at + 1 + j * 3, true) +
            this.view.getUint8(at + 3 + j * 3) * 65536,
        );
      yield {
        words,
        first: this.view.getUint32(at + 16, true),
        end: this.view.getUint32(at + 20, true),
      };
    }
  }
}
