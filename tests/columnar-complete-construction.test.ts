import { it, expect } from "vitest";
import { BuildStore } from "../src/columnar/construction/runs.js";
import {
  CompletePairWriter,
  mergeCompletePairs,
  finishCompletePairs,
  type CompletePairRun,
} from "../src/columnar/construction/complete-pairs.js";
import {
  analyzeDocument,
  resolveDocument,
} from "../src/columnar/construction/analyzed-document.js";
import {
  encodeRangePairRouter,
  PairRouter,
} from "../src/columnar/pair-router.js";
import {
  encodePairMembershipPacket,
  PairMembershipPacket,
  PairMembership,
} from "../src/columnar/pair-membership.js";
import { PairPacket } from "../src/columnar/pair-packet.js";
import { ColumnarR2 } from "../src/columnar/r2.js";
import { pairRangeRun } from "../scripts/construction-complete-pairs.js";

it("bounds merge inputs by hash range without losing a boundary chunk or repeated restart hash", () => {
  const chunks = [1, 10, 10, 20, 30].map((firstHash, i) => ({
    firstHash,
    key: "k" + i,
    size: 1,
    sha256: "a".repeat(64),
  }));
  const run: CompletePairRun = {
    version: 1,
    catalogue: "a".repeat(64),
    first: 0,
    end: 100,
    chunks,
    occurrences: 100,
  };
  expect(pairRangeRun(run, { first: 10, end: 20 }).chunks).toEqual(
    chunks.slice(0, 3),
  );
  expect(pairRangeRun(run, { first: 11, end: 19 }).chunks).toEqual(
    chunks.slice(2, 3),
  );
  expect(pairRangeRun(run, { first: 0, end: 1 }).chunks).toEqual([]);
  expect(pairRangeRun(run, { first: 30, end: 2 ** 32 }).chunks).toEqual(
    chunks.slice(3),
  );
  expect(run.chunks).toHaveLength(5);
});

function fixture() {
  const objects = new Map<string, { raw: Uint8Array; metadata: any }>();
  const bucket = {
    async put(key: string, raw: Uint8Array, options: any) {
      objects.set(key, { raw: raw.slice(), metadata: options?.customMetadata });
      return { size: raw.length };
    },
    async get(key: string, options: any) {
      const e = objects.get(key);
      if (!e) return null;
      const r = options?.range,
        raw = r ? e.raw.slice(r.offset, r.offset + r.length) : e.raw;
      return {
        size: e.raw.length,
        customMetadata: e.metadata,
        arrayBuffer: async () => raw.slice().buffer,
      };
    },
  } as unknown as R2Bucket;
  return { objects, bucket, store: new BuildStore(bucket) };
}
it("constructs all pair memberships and neighboring tokens, resumes merges, splits long documents and routes absent/rare words", async () => {
  const f = fixture(),
    catalogue = "a".repeat(64),
    generation = "b".repeat(64);
  const docs = [
    { body: "in the absence of proof", title: "the absence" },
    { body: "x rareword 法院 end", title: "x rareword" },
    { body: "the the the", title: "the" },
    {
      body: Array.from(
        { length: 18000 },
        (_, i) => ["x", "rareword", "the", "absence"][i % 4],
      ).join(" "),
      title: "",
    },
    { body: "absence of in the", title: "proof end" },
    { body: "singleton", title: "" },
    { body: "", title: "" },
  ].map((d, doc) => analyzeDocument({ doc, id: String(doc), ...d }));
  // High IDs expose the old 16-bit vocabulary assumption without allocating
  // or selecting a restricted pair vocabulary.
  const words = [...new Set(docs.flatMap((d) => d.words))].sort(),
    ids = new Map(words.map((w, i) => [w, 70000 + i]));
  const commonWords = words.map((word) => ({
    word,
    id: ids.get(word)!,
    df: docs.filter((d) => d.words.includes(word)).length,
  }));
  const runs: CompletePairRun[] = [];
  for (let first = 0; first < docs.length; first += 2) {
    const writer = new CompletePairWriter(
      f.store,
      first,
      catalogue,
      new Set(ids.values()),
    );
    for (const d of docs.slice(first, first + 2))
      await writer.append(resolveDocument(d, ids), d, ids);
    runs.push(...(await writer.finish()));
  }
  const chunks: CompletePairRun["chunks"] = [];
  let state: any;
  do {
    const r = await mergeCompletePairs(f.store, runs, state, 500);
    chunks.push(...r.chunks);
    state = r.state;
  } while (!state.done);
  const run = {
      ...runs[0],
      end: docs.length,
      chunks,
      occurrences: runs.reduce((n, r) => n + r.occurrences, 0),
    },
    outputs: any[] = [];
  state = undefined;
  do {
    const r = await finishCompletePairs(
      f.store,
      {
        run,
        generation,
        documents: docs.length,
        objectBase: outputs.length * 16384,
        commonWords,
        state,
      },
      250,
    );
    outputs.push(r);
    state = r.state;
  } while (!state.done);
  const leaves = outputs.flatMap((o) => o.leaves),
    router = new PairRouter(
      encodeRangePairRouter(
        {
          generation,
          baseGeneration: "c".repeat(64),
          documents: docs.length,
          targetBytes: 131072,
          contextBytes: 8192,
          namespaces: [],
          roots: [-2147483648],
          commonWords,
          completeContext: true,
        },
        leaves,
        encodePairMembershipPacket([]),
      ),
    ),
    source = new ColumnarR2(f.bucket);
  type Occ = {
    doc: number;
    field: number;
    position: number;
    previous: number;
    next: number;
  };
  const expected = new Map<string, Occ[]>();
  for (const [doc, d] of docs.entries())
    for (const [field, tokens] of [d.body, d.title].entries())
      for (let p = 1; p < tokens.length; p++) {
        const a = d.words[tokens[p - 1]],
          b = d.words[tokens[p]],
          key = a + "\0" + b,
          list = expected.get(key) ?? [];
        list.push({
          doc,
          field,
          position: p - 1,
          previous: p > 1 ? ids.get(d.words[tokens[p - 2]])! + 1 : 0,
          next:
            p + 1 < tokens.length ? ids.get(d.words[tokens[p + 1]])! + 1 : 0,
        });
        expected.set(key, list);
      }
  expect(outputs.reduce((n, o) => n + o.coverage.pairs, 0)).toBe(expected.size);
  expect(outputs.reduce((n, o) => n + o.coverage.occurrences, 0)).toBe(
    [...expected.values()].reduce((n, r) => n + r.length, 0),
  );
  expect(outputs.flatMap((o) => o.positionObjects).length).toBeGreaterThan(0);
  for (const [key, occurrences] of expected) {
    const [a, b] = key.split("\0"),
      leaf = router.route(a, b)!;
    const raw = await source.readNamed(
        `${generation}/pairs-${leaf.object}.bin@${leaf.offset}`,
        leaf.bytes,
      ),
      member = new PairMembership(
        new PairMembershipPacket(raw).record(a, b)!,
        docs.length,
      );
    expect([...member.documents("all")]).toEqual([
      ...new Set(occurrences.map((o) => o.doc)),
    ]);
    const packets = member.context
      ? [member.context]
      : await Promise.all(
          member.positionDirectory!.chunks.map(
            async (c) =>
              new PairPacket(
                await source.readNamed(
                  member.positionDirectory!.address(c),
                  c.length,
                ),
              ),
          ),
        );
    const actual: Occ[] = [];
    for (const p of packets)
      for (let row = 0; row < p.docs.length; row++)
        for (const field of [0, 1]) {
          const o = p.occurrences(row, field);
          for (let i = 0; i < o.positions.length; i++)
            actual.push({
              doc: p.docs[row],
              field,
              position: o.positions[i],
              previous: o.previous[i],
              next: o.next[i],
            });
        }
    const order = (x: Occ, y: Occ) =>
      x.doc - y.doc || x.field - y.field || x.position - y.position;
    expect(actual.sort(order), key).toEqual(occurrences.sort(order));
  }
  for (const [a, b] of [
    ["the", "unseen"],
    ["x", "singleton"],
  ]) {
    const leaf = router.route(a, b);
    if (leaf) {
      const raw = await source.readNamed(
        `${generation}/pairs-${leaf.object}.bin@${leaf.offset}`,
        leaf.bytes,
      );
      expect(new PairMembershipPacket(raw).record(a, b)).toBeUndefined();
    }
  }
  expect(outputs.flatMap((o) => o.presence)).toHaveLength(commonWords.length);
  for (const p of outputs.flatMap((o) => o.presence))
    expect([
      ...new PairMembership(f.objects.get(p.key)!.raw, docs.length).documents(
        "all",
      ),
    ]).toEqual(docs.flatMap((d, i) => (d.words.includes(p.word) ? [i] : [])));
  // Independently partitioned final merges cover exactly the same occurrences.
  const split = [];
  for (const range of [
    { first: 0, end: 2 ** 31 },
    { first: 2 ** 31, end: 2 ** 32 },
  ]) {
    const r = await mergeCompletePairs(
      f.store,
      runs,
      undefined,
      Infinity,
      range,
    );
    const finished = await finishCompletePairs(
      f.store,
      {
        run: { ...run, chunks: r.chunks },
        generation,
        documents: docs.length,
        objectBase: 1000000 + split.length * 16384,
        commonWords,
      },
      Infinity,
    );
    split.push(finished);
  }
  expect(split.reduce((n, r) => n + r.coverage.occurrences, 0)).toBe(
    run.occurrences,
  );
}, 30000);
