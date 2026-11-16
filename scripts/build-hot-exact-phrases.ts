import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PairRouter } from "../src/columnar/pair-router.js";
import { PairMembershipPacket } from "../src/columnar/pair-membership.js";
import {
  encodeExactPhraseDirectory,
  type ExactPairDescriptor,
} from "../src/columnar/exact-phrase-directory.js";
import { Semaphore } from "../src/columnar/storage.js";
import { benchmarkToken } from "../bench/columnar/token.js";

/** Corpus-selected descriptors only: complete coverage remains in routed packets. */
export async function buildHotExactPhrases(
  router: PairRouter,
  stats: { a: string; b: string; df: number }[],
  read: (key: string, offset: number, bytes: number) => Promise<Uint8Array>,
  limit = 2000,
) {
  if (!router.metadata.completeContext)
    throw Error("Complete context required");
  const selected = [
      ...new Map(stats.map((p) => [p.a + "\0" + p.b, p])).values(),
    ]
      .sort(
        (a, b) =>
          b.df - a.df || a.a.localeCompare(b.a) || a.b.localeCompare(b.b),
      )
      .slice(0, limit),
    groups = new Map<
      string,
      {
        leaf: NonNullable<ReturnType<PairRouter["route"]>>;
        pairs: typeof selected;
      }
    >();
  for (const pair of selected) {
    const leaf = router.route(pair.a, pair.b);
    if (!leaf) throw Error("Missing selected pair route");
    const key = leaf.object + ":" + leaf.offset;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { leaf, pairs: [] }));
    group.pairs.push(pair);
  }
  const slots = new Semaphore(6),
    descriptors: ExactPairDescriptor[] = [];
  await Promise.all(
    [...groups.values()].map((group) =>
      slots.run(async () => {
        const { leaf } = group,
          packet = new PairMembershipPacket(
            await read(
              `${router.metadata.generation}/pairs-${leaf.object}.bin`,
              leaf.offset,
              leaf.bytes,
            ),
          );
        for (const pair of group.pairs) {
          const record = packet.lookup(
            pair.a,
            pair.b,
            router.metadata.documents,
          );
          if (!record || record.df !== pair.df)
            throw Error("Selected pair statistics mismatch");
          if (!record.completePositions) continue; // Inline packets already finish matching in one read.
          if (
            record.completePositions.generation !== router.metadata.generation
          )
            throw Error("Pair context generation mismatch");
          descriptors.push({
            ...pair,
            bodyDf: record.body.count,
            titleDf: record.title.count,
            bodyOccurrences: record.bodyOccurrences,
            titleOccurrences: record.titleOccurrences,
            directory: record.completePositions,
          });
        }
      }),
    ),
  );
  descriptors.sort((a, b) => a.a.localeCompare(b.a) || a.b.localeCompare(b.b));
  return {
    bytes: encodeExactPhraseDirectory(
      {
        generation: router.metadata.generation,
        baseGeneration: router.metadata.baseGeneration,
        documents: router.metadata.documents,
        objects: router.metadata.positionObjects ?? [],
      },
      descriptors,
    ),
    selected: selected.length,
    descriptors: descriptors.length,
    packets: groups.size,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [index, url = "https://work-search-cws-upload.phulin.workers.dev"] =
    process.argv.slice(2);
  if (!index) throw Error("Use INDEX_DIRECTORY [UPLOADER_URL]");
  const root = JSON.parse(await readFile(index + "/root.json", "utf8")),
    router = new PairRouter(await readFile(index + "/membership/router.bin")),
    files = (await readdir(index + "/tasks")).filter((n) =>
      /^complete-finish-.*\.json$/.test(n),
    ),
    stats = [],
    objects = new Map<string, any>(
      root.pairMembership.objects.map((o: any) => [o.key, o]),
    ),
    token = await benchmarkToken();
  for (const file of files) {
    const task = JSON.parse(await readFile(index + "/tasks/" + file, "utf8"));
    if (task.output) stats.push(...task.output.hot);
  }
  const result = await buildHotExactPhrases(
    router,
    stats,
    async (key, offset, length) => {
      const expected = objects.get(key);
      if (!expected || offset + length > expected.size)
        throw Error("Missing immutable pair inventory");
      for (let attempt = 0; ; attempt++)
        try {
          const response = await fetch(url + "/" + key, {
            headers: {
              authorization: `Bearer ${token}`,
              "x-offset": String(offset),
              "x-length": String(length),
            },
            signal: AbortSignal.timeout(120000),
          });
          if (
            !response.ok ||
            response.headers.get("x-sha256") !== expected.sha256 ||
            response.headers.get("x-generation") !== router.metadata.generation
          )
            throw Error("Pair packet identity mismatch: " + response.status);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.length !== length) throw Error("Truncated pair packet");
          return bytes;
        } catch (error) {
          if (attempt === 4) throw error;
        }
    },
  );
  await writeFile(index + "/membership/exact-phrases.bin", result.bytes);
  const { bytes, ...counts } = result;
  await writeFile(
    index + "/membership/hot-descriptors.json",
    JSON.stringify({
      ...counts,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      generation: root.generation,
      selection:
        "Highest document frequency among bounded per-task top-1000 summaries; all pairs remain remotely executable.",
    }),
  );
  console.log(JSON.stringify({ ...counts, bytes: bytes.length }));
}
