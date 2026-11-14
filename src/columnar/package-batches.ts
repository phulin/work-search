/** Budgets cover live raw packages, not cumulative transfer. A package larger
 * than the batch budget runs alone; it is never omitted or partially decoded. */
export const PACKAGE_BATCH_BYTES = 4 * 1048576;
export const PACKAGE_WINNER_BYTES = 4 * 1048576;
export const PACKAGE_CONCURRENCY = 6;
export function* packageBatches<T>(
  input: Iterable<T>,
  size: (item: T) => number,
  budget = PACKAGE_BATCH_BYTES,
  concurrency = PACKAGE_CONCURRENCY,
) {
  let items: T[] = [],
    bytes = 0;
  for (const item of input) {
    const length = size(item);
    if (!Number.isSafeInteger(length) || length < 1)
      throw Error("Invalid package length");
    if (
      items.length &&
      (items.length === concurrency || bytes + length > budget)
    ) {
      yield { items, bytes, oversized: bytes > budget };
      items = [];
      bytes = 0;
    }
    items.push(item);
    bytes += length;
  }
  if (items.length) yield { items, bytes, oversized: bytes > budget };
}
