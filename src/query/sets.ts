export function intersect(a: Uint32Array, b: Uint32Array) {
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
