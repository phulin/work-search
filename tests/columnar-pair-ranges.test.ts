import { it, expect } from "vitest";
import {
  indexPairOccurrenceRuns,
  mergePairOccurrenceRuns,
  type PairRun,
} from "../src/columnar/construction/pair-occurrences.js";
import { BuildStore, type Chunk } from "../src/columnar/construction/runs.js";
import { concat, u32, view } from "../src/columnar/format.js";
import { encodePairPacket, PairPacket } from "../src/columnar/pair-packet.js";

it("parallel pair-key ranges equal a complete occurrence merge across uneven restart boundaries", async () => {
  const objects = new Map<string, Uint8Array>(),
    store = new BuildStore({
      async get(key: string, options: any) {
        const bytes = objects.get(key)!;
        return {
          size: bytes.length,
          arrayBuffer: async () =>
            bytes.slice(
              options.range.offset,
              options.range.offset + options.range.length,
            ).buffer,
        };
      },
    } as unknown as R2Bucket);
  let serial = 0;
  store.put = async (bytes: Uint8Array): Promise<Chunk> => {
    const key = String(serial++);
    objects.set(key, bytes.slice());
    return { key, size: bytes.length, sha256: key };
  };
  const readKeys: string[] = [];
  store.get = async (chunk: Chunk) => {
    readKeys.push(chunk.key);
    return objects.get(chunk.key)!.slice();
  };
  const runs: PairRun[] = [];
  for (let doc = 0; doc < 4; doc++) {
    const keys = [0, 1, 3, 7, 8, 13, 19, 23, 0xfffffffe, 0xffffffff].filter(
        (_, i) => (i + doc) % 3,
      ),
      chunks: Chunk[] = [];
    for (let first = 0; first < keys.length; first += doc + 1) {
      const records = keys.slice(first, first + doc + 1).map((key) => {
        const packet = encodePairPacket(1, 2, [
          {
            doc,
            body: [{ position: doc + (key % 17), previous: 3, next: 4 }],
            title: doc % 2 ? [{ position: 0 }] : [],
          },
        ]);
        return concat([u32([packet.length + 8, key]), packet]);
      });
      chunks.push(await store.put(concat(records)));
    }
    runs.push({ first: doc, end: doc + 1, selection: "selected", chunks });
  }
  const entries = async (run: PairRun) => {
    const rows: any[] = [];
    for (const chunk of run.chunks) {
      const bytes = await store.get(chunk),
        v = view(bytes);
      for (let at = 0; at < bytes.length;) {
        const n = v.getUint32(at, true),
          key = v.getUint32(at + 4, true),
          p = new PairPacket(bytes.subarray(at + 8, at + n));
        rows.push([
          key,
          [...p.docs],
          Array.from({ length: p.docs.length }, (_, i) => [
            p.phrase(i, 0, [3, 1, 2, 4], 1),
            p.phrase(i, 1, [1, 2], 0),
          ]),
        ]);
        at += n;
      }
    }
    return rows;
  };
  const complete = await entries(await mergePairOccurrenceRuns(store, runs)),
    indexed = await indexPairOccurrenceRuns(store, runs),
    boundaries = [0, 1, 2, 8, 17, 24, 0xffffffff, 2 ** 32],
    partials = await Promise.all(
      boundaries.slice(1).map((endKey, i) =>
        mergePairOccurrenceRuns(store, indexed, {
          firstKey: boundaries[i],
          endKey,
        }),
      ),
    );
  expect((await Promise.all(partials.map(entries))).flat()).toEqual(complete);
  readKeys.length = 0;
  await mergePairOccurrenceRuns(store, indexed, {
    firstKey: 0xffffffff,
    endKey: 2 ** 32,
  });
  expect(readKeys.length).toBeLessThanOrEqual(runs.length * 2);
  await expect(
    mergePairOccurrenceRuns(store, runs, { firstKey: 7, endKey: 7 }),
  ).rejects.toThrow("range");
  await expect(
    mergePairOccurrenceRuns(store, runs, { firstKey: 1, endKey: 3 }),
  ).rejects.toThrow("restart");
});
