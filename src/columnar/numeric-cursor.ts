import { lower } from "./format.js";
export interface NumericCursor {
  next(): number;
  /** Consume the first remaining document >= target. */
  advance?(target: number): number;
}
export function arrayCursor(docs: Uint32Array): NumericCursor {
  let row = 0;
  return {
    next: () => (row < docs.length ? docs[row++] : Infinity),
    advance: (target) => {
      row = Math.max(row, lower(docs, target));
      return row < docs.length ? docs[row++] : Infinity;
    },
  };
}
export function advanceCursor(cursor: NumericCursor, target: number) {
  if (cursor.advance) return cursor.advance(target);
  let doc: number;
  do doc = cursor.next();
  while (doc < target);
  return doc;
}
/** Sorted streams, Infinity at EOF. No posting objects or corpus-sized sets. */
export function intersectCursors(cursors: NumericCursor[]): NumericCursor {
  if (cursors.length === 1) return cursors[0];
  const heads = cursors.map((c) => c.next());
  const next = () => {
    if (!heads.length) return Infinity;
    for (;;) {
      let target = Math.max(...heads);
      if (target === Infinity) return Infinity;
      let equal = true;
      for (let i = 0; i < heads.length; i++) {
        if (heads[i] < target) heads[i] = advanceCursor(cursors[i], target);
        if (heads[i] > target) {
          target = heads[i];
          equal = false;
        }
      }
      if (!equal) continue;
      for (let i = 0; i < heads.length; i++) heads[i] = cursors[i].next();
      return target;
    }
  };
  return {
    next,
    advance(target) {
      for (let i = 0; i < heads.length; i++)
        if (heads[i] < target) heads[i] = advanceCursor(cursors[i], target);
      return next();
    },
  };
}
export function unionCursors(
  a: NumericCursor,
  b: NumericCursor,
): NumericCursor {
  let x = a.next(),
    y = b.next();
  const next = () => {
    const doc = Math.min(x, y);
    if (x === doc) x = a.next();
    if (y === doc) y = b.next();
    return doc;
  };
  return {
    next,
    advance(target) {
      if (x < target) x = advanceCursor(a, target);
      if (y < target) y = advanceCursor(b, target);
      return next();
    },
  };
}
