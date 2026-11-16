import { concat, u32, view, pack, unpack, lower } from "./format.js";
import { packedAt } from "./compact-integers.js";
export interface DocumentGroup {
  first: number;
  end: number;
  sha256: string;
  offsets: Uint8Array;
  prefixes?: Uint8Array;
  verificationBytes?: Uint8Array;
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
  [0x32444443, count, groups.length, header.length].forEach((n, i) =>
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
    const prefixes =
        g.prefixes ?? pack(offsets.slice(1).map((end, i) => end - offsets[i])),
      budget = g.verificationBytes ?? prefixes,
      payload = concat([
        u32([g.offsets.length, prefixes.length]),
        g.offsets,
        prefixes,
        budget,
      ]);
    const prefixValues = unpack(prefixes),
      budgetValues = unpack(budget);
    if (
      prefixValues.length !== g.end - g.first ||
      budgetValues.length !== prefixValues.length ||
      prefixValues.some(
        (n, i) =>
          n < 64 ||
          n > budgetValues[i] ||
          budgetValues[i] > offsets[i + 1] - offsets[i],
      )
    )
      throw Error("Invalid document verification locators");
    [g.first, g.end, at, payload.length].forEach((n, j) =>
      v.setUint32(p + j * 4, n, true),
    );
    for (let j = 0; j < 32; j++)
      header[p + 16 + j] = parseInt(g.sha256.slice(j * 2, j * 2 + 2), 16);
    parts.push(payload);
    at += payload.length;
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
  private prefixes = new Uint32Array();
  private verificationBytes = new Uint32Array();
  private lastKey = "";
  private validated: Uint8Array;
  readonly count: number;
  constructor(readonly bytes: Uint8Array) {
    this.data = view(bytes);
    if (bytes.length < 16 || this.data.getUint32(0, true) !== 0x32444443)
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
    this.validated = new Uint8Array(groups);
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
  clear() {
    this.last = -1;
    this.lastKey = "";
    this.offsets = new Uint32Array();
    this.prefixes = new Uint32Array();
    this.verificationBytes = new Uint32Array();
    this.validated.fill(0);
  }
  private group(doc: number) {
    if (!Number.isInteger(doc) || doc < 0 || doc >= this.count)
      throw Error("Invalid document handle");
    let group = lower(this.firsts, doc);
    if (this.firsts[group] !== doc) group--;
    return group;
  }
  private locate(doc: number, group = this.group(doc)) {
    const p = 16 + group * 48,
      first = this.firsts[group],
      end = this.data.getUint32(p + 4, true);
    if (this.last !== group) {
      const at = this.data.getUint32(p + 8, true),
        n = this.data.getUint32(p + 12, true),
        size = this.data.getUint32(at, true),
        prefixSize = this.data.getUint32(at + 4, true),
        offsets = unpack(this.bytes.subarray(at + 8, at + 8 + size)),
        prefixes = unpack(
          this.bytes.subarray(at + 8 + size, at + 8 + size + prefixSize),
        ),
        budgets = unpack(
          this.bytes.subarray(at + 8 + size + prefixSize, at + n),
        );
      if (
        offsets.length !== end - first + 1 ||
        offsets[0] !== 0 ||
        offsets.some((n, i) => i > 0 && n <= offsets[i - 1]) ||
        prefixes.length !== end - first ||
        budgets.length !== end - first ||
        budgets.some(
          (n, i) => n < prefixes[i] || n > offsets[i + 1] - offsets[i],
        ) ||
        prefixes.some((n, i) => n < 64 || n > offsets[i + 1] - offsets[i])
      )
        throw Error("Invalid package offsets");
      this.offsets = offsets;
      this.prefixes = prefixes;
      this.verificationBytes = budgets;
      this.last = group;
      this.lastKey = "";
      this.validated[group] = 1;
    }
    return group;
  }
  /** Planning needs a numeric byte count, not a result locator or string key. */
  verificationSize(doc: number) {
    const group = this.group(doc),
      row = doc - this.firsts[group];
    if (!this.validated[group]) this.locate(doc, group);
    if (this.last === group) return this.verificationBytes[row];
    const p = 16 + group * 48,
      at = this.data.getUint32(p + 8, true),
      end = at + this.data.getUint32(p + 12, true),
      start =
        at +
        8 +
        this.data.getUint32(at, true) +
        this.data.getUint32(at + 4, true);
    return packedAt(this.bytes.subarray(start, end), row);
  }
  lookup(doc: number) {
    const group = this.locate(doc),
      first = this.firsts[group];
    if (!this.lastKey) {
      const p = 16 + group * 48,
        sha256 = [...this.bytes.subarray(p + 16, p + 48)]
          .map((n) => n.toString(16).padStart(2, "0"))
          .join("");
      this.lastKey = `${sha256}/plan-0.bin`;
    }
    return {
      key: this.lastKey,
      first,
      offset: this.offsets[doc - first],
      length: this.offsets[doc - first + 1] - this.offsets[doc - first],
      prefixLength: this.prefixes[doc - first],
      verificationBytes: this.verificationBytes[doc - first],
    };
  }
  *groups() {
    for (let i = 0; i < this.firsts.length; i++) {
      const first = this.firsts[i],
        end = i + 1 < this.firsts.length ? this.firsts[i + 1] : this.count;
      const start = this.lookup(first),
        last = this.lookup(end - 1);
      yield { first, end, key: start.key, bytes: last.offset + last.length };
    }
  }
}
export { pack };
