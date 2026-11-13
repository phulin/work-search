import type { Branch } from "./format.js";
export interface Hit {
  doc: number;
  score: number;
  branch?: Branch;
  row: number;
  first?: number;
  titleOnly?: boolean;
}
const better = (a: Hit, b: Hit) =>
  a.score > b.score || (a.score === b.score && a.doc < b.doc);
export class Heap {
  values: Hit[] = [];
  constructor(readonly k: number) {}
  get threshold() {
    return this.values.length === this.k ? this.values[0] : undefined;
  }
  accepts(doc: number, score: number) {
    const t = this.threshold;
    return !t || score > t.score || (score === t.score && doc < t.doc);
  }
  add(h: Hit) {
    const a = this.values;
    if (!this.accepts(h.doc, h.score)) return;
    if (a.length < this.k) {
      a.push(h);
      let i = a.length - 1;
      while (i) {
        const p = (i - 1) >>> 1;
        if (!better(a[p], a[i])) break;
        [a[i], a[p]] = [a[p], a[i]];
        i = p;
      }
    } else {
      a[0] = h;
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let c = i * 2 + 1;
        if (c + 1 < a.length && better(a[c], a[c + 1])) c++;
        if (!better(a[i], a[c])) break;
        [a[i], a[c]] = [a[c], a[i]];
        i = c;
      }
    }
  }
}
