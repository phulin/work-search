import { expect, it } from "vitest";
import { assembleWords, encodeWords } from "../src/columnar/word-directory.js";
import { ConstructionWordLookup } from "../src/columnar/construction/word-lookup.js";
import { BuildStore, digest } from "../src/columnar/construction/runs.js";
import type { WordPacket } from "../src/columnar/construction/word-lookup.js";
import { packageRanges } from "../scripts/construction-package-plan.js";

it("maps sparse common IDs and the complete tail exactly with bounded, deduplicated packet reads", async () => {
  const names = Array.from(
      { length: 400 },
      (_, i) => "word" + String(i).padStart(4, "0"),
    ),
    objects = new Map<string, Uint8Array>(),
    packets: WordPacket[] = [];
  for (let at = 0; at < names.length; at += 20) {
    const words = names.slice(at, at + 20),
      raw = assembleWords([
        { first: words[0], count: words.length, data: encodeWords(words) },
      ]),
      sha256 = await digest(raw),
      key = sha256 + "/plan-0.bin";
    objects.set(key, raw);
    packets.push({
      first: words[0],
      last: words.at(-1)!,
      firstId: at + 1,
      count: words.length,
      ref: { key, size: raw.length, sha256 },
    });
  }
  const ids = Uint32Array.of(2, 57, 303),
    hotWords = [names[1], names[56], names[302]],
    config = {
      generation: "a".repeat(64),
      count: 100,
      rootSha256: "b".repeat(64),
      hot: assembleWords([
        {
          first: hotWords[0],
          count: hotWords.length,
          data: encodeWords(hotWords),
        },
      ]),
      ids,
      packets,
    };
  let active = 0,
    peak = 0,
    reads = 0;
  const bucket = {
    async get(key: string) {
      reads++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 0));
      active--;
      const bytes = objects.get(key)!;
      return {
        size: bytes.length,
        customMetadata: {
          sha256: key.split("/")[0],
          generation: key.split("/")[0],
        },
        arrayBuffer: async () => Uint8Array.from(bytes).buffer,
      };
    },
  } as unknown as R2Bucket;
  const lookup = new ConstructionWordLookup(config),
    cold = lookup.request(new BuildStore(bucket)),
    found = await cold.lookup([
      ...names,
      "absent",
      "word0000a",
      "zzz",
      names[3],
    ]);
  expect(found).toEqual(new Map(names.map((word, i) => [word, i + 1])));
  expect(reads).toBe(packets.length);
  expect(peak).toBeLessThanOrEqual(6);
  expect(cold.stats.hits).toBe(3);
  expect(cold.stats.requests).toBe(packets.length);
  const hot = lookup.request(new BuildStore(bucket));
  expect(await hot.lookup(hotWords)).toEqual(
    new Map(hotWords.map((w, i) => [w, ids[i]])),
  );
  expect(hot.stats.requests).toBe(0);
  const reused = lookup.request(new BuildStore(bucket));
  expect(await reused.lookup(names)).toEqual(found);
  expect(reused.stats.requests).toBe(0);
  expect(
    () =>
      new ConstructionWordLookup({
        ...config,
        ids: Uint32Array.of(2, 303, 57),
      }),
  ).toThrow("hot IDs");
  expect(
    () => new ConstructionWordLookup({ ...config, packets: packets.slice(1) }),
  ).toThrow("routing");
});

it("covers every document once when retaining partial range vocabularies and resolving the gaps directly", () => {
  const ref = {
      key: "a".repeat(64) + "/plan-0.bin",
      size: 10,
      sha256: "a".repeat(64),
    },
    ranges = packageRanges(10013, [
      { segments: [{ first: 1500, end: 1533, ref }] },
      {
        segments: [
          { first: 0, end: 1100, ref },
          { first: 9000, end: 9200, ref },
        ],
      },
    ]);
  expect(
    ranges.flatMap((r) =>
      Array.from({ length: r.end - r.first }, (_, i) => r.first + i),
    ),
  ).toEqual(Array.from({ length: 10013 }, (_, i) => i));
  expect(ranges.every((r) => r.end - r.first <= 1024)).toBe(true);
  expect(
    ranges.filter((r) => r.ref).reduce((n, r) => n + r.end - r.first, 0),
  ).toBe(1333);
  expect(() =>
    packageRanges(20, [
      {
        segments: [
          { first: 1, end: 10, ref },
          { first: 9, end: 11, ref },
        ],
      },
    ]),
  ).toThrow("coverage");
});

it("preserves exact Unicode word identities in both common and remote lookups", async () => {
  const names = ["cafe", "café", "naïve", "über", "東京"].sort(),
    raw = assembleWords([
      { first: names[0], count: names.length, data: encodeWords(names) },
    ]),
    sha256 = await digest(raw),
    ref = { key: sha256 + "/plan-0.bin", size: raw.length, sha256 },
    store = { get: async () => raw } as unknown as BuildStore,
    lookup = new ConstructionWordLookup({
      generation: "a".repeat(64),
      count: 1,
      rootSha256: "b".repeat(64),
      hot: assembleWords([
        { first: "café", count: 1, data: encodeWords(["café"]) },
      ]),
      ids: Uint32Array.of(names.indexOf("café") + 1),
      packets: [
        {
          first: names[0],
          last: names.at(-1)!,
          firstId: 1,
          count: names.length,
          ref,
        },
      ],
    }).request(store);
  expect(await lookup.lookup(names)).toEqual(
    new Map(names.map((w, i) => [w, i + 1])),
  );
});
