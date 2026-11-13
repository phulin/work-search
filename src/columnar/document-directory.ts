import { concat, u32, view, pack, unpack, lower } from "./format.js";
export interface DocumentGroup {
  first: number;
  end: number;
  sha256: string;
  offsets: Uint8Array;
}
/** Complete direct package addresses: one restart per physical group and packed
 * byte offsets within it. The content-addressed group key needs no remote lookup. */
export function encodeDocumentDirectory(
  groups: DocumentGroup[],
  count: number,
) {
  const header = new Uint8Array(16 + groups.length * 48),
    v = view(header),
    parts: Uint8Array[] = [header];
  [0x31444443, count, groups.length, header.length].forEach((n, i) =>
    v.setUint32(i * 4, n, true),
  );
  let at = header.length,
    next = 0;
  groups.forEach((g, i) => {
    const offsets = unpack(g.offsets),
      p = 16 + i * 48;
    if (
      g.first !== next ||
      g.end <= g.first ||
      g.end > count ||
      offsets.length !== g.end - g.first + 1 ||
      offsets[0] !== 0 ||
      offsets.some((n, i) => i > 0 && n <= offsets[i - 1]) ||
      !/^[a-f0-9]{64}$/.test(g.sha256)
    )
      throw Error("Invalid document group coverage");
    [g.first, g.end, at, g.offsets.length].forEach((n, j) =>
      v.setUint32(p + j * 4, n, true),
    );
    for (let j = 0; j < 32; j++)
      header[p + 16 + j] = parseInt(g.sha256.slice(j * 2, j * 2 + 2), 16);
    parts.push(g.offsets);
    at += g.offsets.length;
    next = g.end;
  });
  if (next !== count) throw Error("Incomplete document directory");
  return concat(parts);
}
export class DocumentDirectory {
  private data: DataView;
  private firsts: Uint32Array;
  private last = -1;
  private offsets = new Uint32Array();
  readonly count: number;
  constructor(readonly bytes: Uint8Array) {
    this.data = view(bytes);
    if (bytes.length < 16 || this.data.getUint32(0, true) !== 0x31444443)
      throw Error("Invalid document directory");
    this.count = this.data.getUint32(4, true);
    const groups = this.data.getUint32(8, true),
      header = 16 + groups * 48;
    if (
      !groups ||
      header > bytes.length ||
      this.data.getUint32(12, true) !== header
    )
      throw Error("Invalid document group table");
    this.firsts = new Uint32Array(groups);
    let next = 0,
      offset = header;
    for (let i = 0; i < groups; i++) {
      const p = 16 + i * 48,
        first = this.data.getUint32(p, true),
        end = this.data.getUint32(p + 4, true),
        at = this.data.getUint32(p + 8, true),
        n = this.data.getUint32(p + 12, true);
      if (
        first !== next ||
        end <= first ||
        end > this.count ||
        at !== offset ||
        !n ||
        at + n > bytes.length
      )
        throw Error("Invalid document group address");
      this.firsts[i] = first;
      next = end;
      offset = at + n;
    }
    if (next !== this.count || offset !== bytes.length)
      throw Error("Incomplete document group directory");
  }
  lookup(doc: number) {
    if (!Number.isInteger(doc) || doc < 0 || doc >= this.count)
      throw Error("Invalid document handle");
    let group = lower(this.firsts, doc);
    if (this.firsts[group] !== doc) group--;
    const p = 16 + group * 48,
      first = this.firsts[group],
      end = this.data.getUint32(p + 4, true);
    if (this.last !== group) {
      const at = this.data.getUint32(p + 8, true),
        n = this.data.getUint32(p + 12, true),
        offsets = unpack(this.bytes.subarray(at, at + n));
      if (
        offsets.length !== end - first + 1 ||
        offsets[0] !== 0 ||
        offsets.some((n, i) => i > 0 && n <= offsets[i - 1])
      )
        throw Error("Invalid package offsets");
      this.offsets = offsets;
      this.last = group;
    }
    const sha256 = [...this.bytes.subarray(p + 16, p + 48)]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    return {
      key: `${sha256}/plan-0.bin`,
      first,
      offset: this.offsets[doc - first],
      length: this.offsets[doc - first + 1] - this.offsets[doc - first],
    };
  }
}
export { pack };
