/** Count actual R2 method invocations, including receipts and retries. GETs and
 * PUTs are separate; mixed "writesAndMergeReads" is retained for older logs. */
export function countedBucket(bucket: R2Bucket) {
  const operations: Record<string, number> = {};
  const failures: Record<string, number> = {};
  let bytesRead = 0,
    bytesWritten = 0;
  return {
    operations,
    snapshot: () => ({
      operations: { ...operations },
      failures: { ...failures },
      bytesRead,
      bytesWritten,
    }),
    bucket: new Proxy(bucket, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          operations[String(key)] = (operations[String(key)] ?? 0) + 1;
          try {
            const result = await value.apply(target, args);
            // R2 size is the full object size; range.length is the returned
            // payload. HEAD and conditional misses transfer no object body.
            if (key === "get" && result)
              bytesRead += result.range?.length ?? result.size;
            if (key === "put" && result) bytesWritten += result.size;
            return result;
          } catch (error) {
            failures[String(key)] = (failures[String(key)] ?? 0) + 1;
            throw error;
          }
        };
      },
    }),
  };
}
