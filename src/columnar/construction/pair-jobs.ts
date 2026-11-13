import { BuildStore, type Chunk } from "./runs.js";
import { unpack, type PositionalPair } from "../format.js";
import {
  documentGroupPairStatistics,
  mergePairStatistics,
  PairStatistics,
} from "./pair-statistics.js";
import {
  documentGroupPairRuns,
  pairRunEntries,
  type PairSelection,
  type PairRun,
} from "./pair-occurrences.js";
import { ObjectStore, PackedWriter } from "./finish.js";
import { PairPacket } from "../pair-packet.js";
export interface PairStatisticsRun {
  first: number;
  end: number;
  vocabulary: string;
  data: Chunk;
}
export async function pairStatisticsJob(
  store: BuildStore,
  input: {
    vocabularyRef: Chunk;
    group: { first: number; end: number; sha256: string; offsets: string };
  },
): Promise<PairStatisticsRun> {
  const vocabulary = JSON.parse(
      new TextDecoder().decode(await store.get(input.vocabularyRef)),
    ),
    g = input.group,
    offsets = unpack(Uint8Array.from(atob(g.offsets), (c) => c.charCodeAt(0)));
  if (
    !Number.isInteger(g.first) ||
    g.first < 0 ||
    g.end - g.first > 128 ||
    g.end <= g.first ||
    offsets.length !== g.end - g.first + 1 ||
    !/^[a-f0-9]{64}$/.test(g.sha256) ||
    !Array.isArray(vocabulary.terms) ||
    g.end > vocabulary.documents
  )
    throw Error("Invalid pair statistics group");
  const bytes = await store.get({
      key: `${g.sha256}/plan-0.bin`,
      size: offsets.at(-1)!,
      sha256: g.sha256,
    }),
    data = documentGroupPairStatistics(
      bytes,
      offsets,
      g.first,
      vocabulary.terms.map((t: any) => t.id),
    );
  return {
    first: g.first,
    end: g.end,
    vocabulary: input.vocabularyRef.sha256,
    data: await store.put(data),
  };
}
export async function mergePairStatisticsJob(
  store: BuildStore,
  input: { runs: PairStatisticsRun[] },
) {
  if (
    !Array.isArray(input.runs) ||
    !input.runs.length ||
    input.runs.length > 4 ||
    input.runs.some(
      (r, i) =>
        r.vocabulary !== input.runs[0].vocabulary ||
        (i > 0 && r.first !== input.runs[i - 1].end),
    )
  )
    throw Error("Invalid pair statistics merge coverage");
  const inputs = await Promise.all(
      input.runs.map(async (r) => {
        const stats = new PairStatistics(await store.get(r.data));
        if (stats.first !== r.first || stats.end !== r.end)
          throw Error("Pair statistics receipt mismatch");
        return stats;
      }),
    ),
    bytes = mergePairStatistics(inputs);
  return {
    first: inputs[0].first,
    end: inputs.at(-1)!.end,
    vocabulary: input.runs[0].vocabulary,
    data: await store.put(bytes),
  };
}
export async function pairOccurrencesJob(
  store: BuildStore,
  input: {
    selectionRef: Chunk;
    group: { first: number; end: number; sha256: string; offsets: string };
  },
) {
  const selection: PairSelection = JSON.parse(
      new TextDecoder().decode(await store.get(input.selectionRef)),
    ),
    g = input.group,
    offsets = unpack(Uint8Array.from(atob(g.offsets), (c) => c.charCodeAt(0)));
  if (
    !Number.isInteger(g.first) ||
    g.first < 0 ||
    g.end - g.first > 128 ||
    g.end <= g.first ||
    offsets.length !== g.end - g.first + 1 ||
    !/^[a-f0-9]{64}$/.test(g.sha256) ||
    g.end > selection.documents
  )
    throw Error("Invalid positional pair group");
  const bytes = await store.get({
    key: `${g.sha256}/plan-0.bin`,
    size: offsets.at(-1)!,
    sha256: g.sha256,
  });
  return {
    runs: await documentGroupPairRuns(
      store,
      bytes,
      offsets,
      g.first,
      selection,
      input.selectionRef.sha256,
    ),
  };
}
export async function finishPairsJob(
  store: BuildStore,
  input: { selectionRef: Chunk; run: PairRun; objectBase: number },
) {
  const selection: PairSelection = JSON.parse(
    new TextDecoder().decode(await store.get(input.selectionRef)),
  );
  if (
    input.run.selection !== input.selectionRef.sha256 ||
    input.run.first !== 0 ||
    input.run.end !== selection.documents
  )
    throw Error("Incomplete positional pair corpus");
  const selected = new Map(selection.pairs.map((p) => [p.key, p])),
    objects = new ObjectStore(store, input.objectBase),
    writer = new PackedWriter(objects),
    descriptors: Record<string, PositionalPair> = {};
  let count = 0,
    occurrences = 0,
    bytes = 0;
  for await (const { key, packet: raw } of pairRunEntries(store, input.run)) {
    const p = new PairPacket(raw),
      expected = selected.get(key);
    let n = 0;
    for (let row = 0; row < p.docs.length; row++)
      n += p.count(row, 0) + p.count(row, 1);
    if (
      !expected ||
      p.a !== expected.a ||
      p.b !== expected.b ||
      p.docs.length !== expected.df ||
      n !== expected.occurrences ||
      raw.length > expected.cost
    )
      throw Error("Positional pair corpus statistics mismatch");
    descriptors[`${p.a}:${p.b}`] = {
      a: p.a,
      b: p.b,
      df: p.docs.length,
      occurrences: n,
      ref: await writer.put(raw),
    };
    count++;
    occurrences += n;
    bytes += raw.length;
  }
  if (count !== selected.size) throw Error("Missing selected positional pair");
  await writer.flush();
  return {
    objects: objects.objects,
    descriptors,
    coverage: {
      documents: selection.documents,
      vocabulary: selection.terms.length,
      pairs: count,
      occurrences,
      bytes,
    },
  };
}
