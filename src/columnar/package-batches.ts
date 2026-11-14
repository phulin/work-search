/** Budgets cover live raw packages, not cumulative transfer. A package larger
 * than the batch budget runs alone; it is never omitted or partially decoded. */
export const PACKAGE_BATCH_BYTES = 4 * 1048576;
export const PACKAGE_WINNER_BYTES = 4 * 1048576;
export const PACKAGE_CONCURRENCY = 6;
export interface PackagePipelineState<T> {
  reserved: ReadonlyMap<number, { item: T; bytes: number }>;
  pending: number;
  loads: number;
  waits: number;
}
/** Keep requests moving as individual packages finish. Reservations include
 * in-flight, completed and currently yielded raw packages; release a yielded
 * package only when the consumer resumes. Oversized packages run alone. */
export async function* packagePipeline<T, V>(
  input: Iterable<T> | AsyncIterable<T>,
  size: (item: T) => number,
  load: (item: T) => Promise<V>,
  progress: (state: PackagePipelineState<T>) => void = () => {},
  budget = PACKAGE_BATCH_BYTES,
  concurrency = PACKAGE_CONCURRENCY,
) {
  if (
    !Number.isSafeInteger(budget) ||
    budget < 1 ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1
  )
    throw Error("Invalid package pipeline budget");
  const iterator =
      Symbol.asyncIterator in input
        ? input[Symbol.asyncIterator]()
        : input[Symbol.iterator](),
    reserved = new Map<number, { item: T; bytes: number }>(),
    pending = new Map<
      number,
      Promise<
        | { id: number; ok: true; item: T; value: V }
        | { id: number; ok: false; error: unknown }
      >
    >();
  let next: { item: T; bytes: number } | undefined,
    done = false,
    bytes = 0,
    id = 0,
    loads = 0,
    waits = 0;
  const note = () =>
    progress({ reserved, pending: pending.size, loads, waits });
  async function fill() {
    while (!done && pending.size < concurrency) {
      if (!next) {
        const value = await iterator.next();
        if (value.done) {
          done = true;
          break;
        }
        const length = size(value.value);
        if (!Number.isSafeInteger(length) || length < 1)
          throw Error("Invalid package length");
        next = { item: value.value, bytes: length };
      }
      if (reserved.size && bytes + next.bytes > budget) break;
      const entry = next,
        key = id++;
      next = undefined;
      reserved.set(key, entry);
      bytes += entry.bytes;
      loads++;
      pending.set(
        key,
        Promise.resolve()
          .then(() => load(entry.item))
          .then(
            (value) => ({
              id: key,
              ok: true as const,
              item: entry.item,
              value,
            }),
            (error) => ({ id: key, ok: false as const, error }),
          ),
      );
      note();
    }
  }
  try {
    await fill();
    while (pending.size) {
      waits++;
      const result = await Promise.race(pending.values());
      pending.delete(result.id);
      if (!result.ok) throw result.error;
      await fill();
      note();
      try {
        yield { item: result.item, value: result.value };
      } finally {
        bytes -= reserved.get(result.id)!.bytes;
        reserved.delete(result.id);
        note();
      }
      await fill();
    }
  } finally {
    // Every load has a rejection handler. Drain outstanding reads on error or
    // early return before releasing their reservations and request context.
    await Promise.all(pending.values());
    await iterator.return?.();
    pending.clear();
    reserved.clear();
    note();
  }
}
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
