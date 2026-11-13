export interface NumericCursor {
  next(): number;
}
/** Sorted streams, Infinity at EOF. No posting objects or corpus-sized sets. */
export function intersectCursors(cursors: NumericCursor[]): NumericCursor {
  if (cursors.length === 1) return cursors[0];
  const heads = cursors.map((c) => c.next());
  return {
    next() {
      if (!heads.length) return Infinity;
      for (;;) {
        let target = Math.max(...heads);
        if (target === Infinity) return Infinity;
        let equal = true;
        for (let i = 0; i < heads.length; i++) {
          while (heads[i] < target) heads[i] = cursors[i].next();
          if (heads[i] > target) {
            target = heads[i];
            equal = false;
          }
        }
        if (!equal) continue;
        for (let i = 0; i < heads.length; i++) heads[i] = cursors[i].next();
        return target;
      }
    },
  };
}
export function unionCursors(
  a: NumericCursor,
  b: NumericCursor,
): NumericCursor {
  let x = a.next(),
    y = b.next();
  return {
    next() {
      const doc = Math.min(x, y);
      if (x === doc) x = a.next();
      if (y === doc) y = b.next();
      return doc;
    },
  };
}
