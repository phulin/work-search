/** Count actual R2 method invocations, including receipts and retries. GETs and
 * PUTs are separate; mixed "writesAndMergeReads" is retained for older logs. */
export function countedBucket(bucket: R2Bucket) {
  const operations: Record<string, number> = {};
  return {
    operations,
    bucket: new Proxy(bucket, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          operations[String(key)] = (operations[String(key)] ?? 0) + 1;
          return value.apply(target, args);
        };
      },
    }),
  };
}
