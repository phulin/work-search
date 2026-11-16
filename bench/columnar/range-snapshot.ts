import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { unionReadRanges, type ReadRange } from "./read-ranges.js";

export interface RangeSnapshot {
  format: "benchmark-ranges-1";
  generation: string;
  corpusHash: string;
  bytes: number;
  ranges: number;
}

export async function loadRangeSnapshot(
  directory: string,
  generation: string,
  corpusHash: string,
) {
  const raw = await readFile(directory + "/range-snapshot.json", "utf8").catch(
    (e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    },
  );
  if (!raw) return;
  const snapshot = JSON.parse(raw) as RangeSnapshot;
  if (
    snapshot.format !== "benchmark-ranges-1" ||
    snapshot.generation !== generation ||
    snapshot.corpusHash !== corpusHash
  )
    throw Error("Benchmark data generation mismatch");
  return snapshot;
}

/** Copy only verified available coverage. Unread holes are never materialized
 * as zeros: the normal RangeStorage reader rejects them during replay. */
export async function writePreparedRanges(
  ranges: Iterable<ReadRange>,
  directory: string,
  read: (key: string, offset: number, length: number) => Promise<Uint8Array>,
) {
  const merged = unionReadRanges(ranges);
  await mkdir(directory, { recursive: true });
  let bytes = 0;
  for (const { key, offset, length } of merged) {
    const data = await read(key, offset, length);
    if (data.length !== length) throw Error("Truncated benchmark data");
    const file = createHash("sha256")
      .update(`${key}:${offset}:${length}`)
      .digest("hex");
    await writeFile(directory + "/" + file, data);
    await writeFile(
      directory + "/" + file + ".json",
      JSON.stringify({
        key,
        offset,
        file,
        bytes: length,
        sha256: createHash("sha256").update(data).digest("hex"),
      }),
    );
    bytes += length;
  }
  return { bytes, ranges: merged.length };
}
