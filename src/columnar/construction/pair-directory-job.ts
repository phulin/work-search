import { encodePairDirectory, comparePair } from "../pair-directory.js";
import type { Root, PositionalPair, PairDirectoryShard } from "../format.js";
import { Reader, Memory, Lru } from "../storage.js";
import { ColumnarR2 } from "../r2.js";
import { ObjectStore, PackedWriter } from "./finish.js";
import type { BuildStore } from "./runs.js";
export async function finishPairDirectoryJob(
  store: BuildStore,
  input: {
    pairs: PositionalPair[];
    objects: Root["objects"];
    objectIds: number[];
    objectBase: number;
  },
) {
  if (
    !input.pairs.length ||
    input.pairs.length > 256 ||
    input.objects.length !== input.objectIds.length
  )
    throw Error("Invalid pair directory job");
  const entries = [...input.pairs].sort((a, b) =>
      comparePair([a.a, a.b], [b.a, b.b]),
    ),
    root: Root = {
      format: "CWS1",
      generation: "0".repeat(64),
      corpusHash: "0".repeat(64),
      count: 1,
      avgBody: 1,
      avgTitle: 1,
      documents: [],
      dictionaries: [],
      hot: {},
      objects: input.objects,
      objectIds: input.objectIds,
    },
    memory = new Memory(),
    reader = new Reader(root, new ColumnarR2(store.bucket), memory),
    output = new ObjectStore(store, input.objectBase),
    writer = new PackedWriter(output),
    shards: PairDirectoryShard[] = [];
  memory.pages = new Lru(4 * 1048576);
  const inlined = new Map<PositionalPair, Uint8Array>();
  // Copy only small payloads; never retain a physical page per tiny posting.
  for (let i = 0; i < entries.length; i += 16) {
    const small = entries.slice(i, i + 16).filter((p) => p.ref[2] <= 16384),
      raw = await reader.many(small.map((p) => p.ref));
    small.forEach((p, j) => inlined.set(p, raw[j].slice()));
  }
  let batch: { pair: PositionalPair; inline?: Uint8Array }[] = [],
    bytes = 16;
  const flush = async () => {
    if (!batch.length) return;
    const ref = await writer.put(encodePairDirectory(batch));
    shards.push({
      first: [batch[0].pair.a, batch[0].pair.b],
      last: [batch.at(-1)!.pair.a, batch.at(-1)!.pair.b],
      ref,
    });
    batch = [];
    bytes = 16;
  };
  for (const pair of entries) {
    const inline = inlined.get(pair),
      size = 40 + (inline?.length ?? 0);
    if (batch.length && bytes + size > 128 * 1024) await flush();
    batch.push({ pair, inline });
    bytes += size;
  }
  await flush();
  await writer.flush();
  return {
    objects: output.objects,
    shards,
    pairs: entries.length,
    inlineBytes: [...inlined.values()].reduce((n, b) => n + b.length, 0),
    readRequests: reader.stats.requests,
    readBytes: reader.stats.bytes,
  };
}
