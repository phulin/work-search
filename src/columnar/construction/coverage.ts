/** Reduce acknowledged immutable package ranges into a bounded publication
 * receipt. Repeating this operation is safe; no package objects are rewritten. */
export async function verifyPackageCoverage(
  bucket: R2Bucket,
  input: { build: string; task: string; generation: string; tasks: string[] },
) {
  if (
    !/^[a-z0-9-]{1,80}$/.test(input.build) ||
    !/^coverage-[a-z0-9-]{1,70}$/.test(input.task) ||
    !/^[a-f0-9]{64}$/.test(input.generation) ||
    !Array.isArray(input.tasks) ||
    !input.tasks.length ||
    input.tasks.length > 256 ||
    input.tasks.some((t) => !/^[a-z0-9-]{1,80}$/.test(t))
  )
    throw Error("Invalid package coverage group");
  let first: number | undefined,
    next: number | undefined,
    bytes = 0;
  for (let at = 0; at < input.tasks.length; at += 4) {
    const receipts = await Promise.all(
      input.tasks.slice(at, at + 4).map(async (task) => {
        const object = await bucket.get(
          `cws-build/${input.build}/${task}.json`,
        );
        if (!object) throw Error("Missing package coverage receipt");
        return (await object.json<any>()).result?.output;
      }),
    );
    for (const r of receipts) {
      if (
        !r ||
        r.generation !== input.generation ||
        !Number.isInteger(r.first) ||
        !Number.isInteger(r.end) ||
        r.first < 0 ||
        r.end <= r.first ||
        r.documents !== r.end - r.first ||
        !Number.isSafeInteger(r.bytes) ||
        r.bytes <= 0 ||
        (next !== undefined && r.first !== next)
      )
        throw Error("Invalid or discontinuous package coverage");
      first ??= r.first;
      next = r.end;
      bytes += r.bytes;
    }
  }
  const output = {
    generation: input.generation,
    first: first!,
    end: next!,
    documents: next! - first!,
    bytes,
  };
  await bucket.put(
    `cws-build/${input.build}/${input.task}.json`,
    JSON.stringify({ result: { output } }),
  );
  return output;
}
