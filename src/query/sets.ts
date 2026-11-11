// Exponential seek followed by binary search, useful for highly skewed lists.
export function lowerBound(a: Uint32Array, value: number, start = 0): number {
  if (start >= a.length || a[start] >= value) return start;
  let step = 1;
  while (start + step < a.length && a[start + step] < value) step *= 2;
  let lo = start + Math.floor(step / 2) + 1,
    hi = Math.min(a.length, start + step + 1);
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (a[m] < value) lo = m + 1;
    else hi = m;
  }
  return lo;
}
export function intersect(a: Uint32Array, b: Uint32Array) {
  if (a.length > b.length) [a, b] = [b, a];
  if (a.length * 8 < b.length) {
    const out = new Uint32Array(a.length);
    let row = 0,
      j = 0;
    for (const doc of a) {
      j = lowerBound(b, doc, j);
      if (j === b.length) break;
      if (b[j] === doc) out[row++] = doc;
    }
    return out.slice(0, row);
  }
  const out: number[] = [];
  let i = 0,
    j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(a[i++]);
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  return Uint32Array.from(out);
}
export function union(a: Uint32Array, b: Uint32Array) {
  const out: number[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    const x = i < a.length ? a[i] : Infinity,
      y = j < b.length ? b[j] : Infinity;
    out.push(Math.min(x, y));
    if (x <= y) i++;
    if (y <= x) j++;
  }
  return Uint32Array.from(out);
}
export function difference(a: Uint32Array, b: Uint32Array) {
  let j = 0;
  return a.filter((x) => {
    while (j < b.length && b[j] < x) j++;
    return b[j] !== x;
  });
}
