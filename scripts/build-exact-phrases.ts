/** Offline, bounded-memory enrichment from the complete builder's occurrence
 * partitions. Selection uses corpus DF/occurrence volume, never query strings. */
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  open,
  appendFile,
  rm,
  symlink,
  lstat,
} from "node:fs/promises";
import { resolve } from "node:path";
import { openSync, readSync, closeSync } from "node:fs";
import { deserialize } from "node:v8";
import { createHash } from "node:crypto";
import { PairRouter } from "../src/columnar/pair-router.js";
import { PairMembershipPacket } from "../src/columnar/pair-membership.js";
import {
  pairPositionChunks,
  encodePairPositionDirectory,
} from "../src/columnar/pair-positions.js";
import { pairStringHash, pairHash } from "../src/columnar/pair-membership.js";
import { PacketObjects } from "../src/columnar/packet-objects.js";
import {
  ExactPhraseDirectory,
  encodeExactPhraseDirectory,
  completePairRanges,
} from "../src/columnar/exact-phrase-directory.js";
import { PairPositionDirectory } from "../src/columnar/pair-positions.js";
import {
  type PairColumnRow,
  pairPacketByteBound,
} from "../src/columnar/pair-packet.js";
const [input, output, index, budgetArg = "65536"] = process.argv.slice(2);
if (!index)
  throw Error(
    "Usage: build-exact-phrases.ts COMPLETE_PAIRS OUTPUT BASE_INDEX [BUDGET_MIB] [--verify-selection]",
  );
await mkdir(output + "/position-scratch", { recursive: true });
await mkdir(output + "/objects", { recursive: true });
const budget = Number(budgetArg) * 1048576,
  started = performance.now(),
  sourceMetadata = JSON.parse(
    await readFile(input + "/specification.json", "utf8"),
  ),
  sourceStatistics = JSON.parse(
    await readFile(input + "/statistics.json", "utf8"),
  ),
  namespaces = new Map<string, number>(
    sourceMetadata.namespaces.map((s: string, i: number) => [s, i + 1]),
  ),
  router = new PairRouter(await readFile(index + "/router.bin")),
  vocab = deserialize(await readFile(input + "/vocabulary.bin")),
  common = JSON.parse(await readFile(input + "/common-pairs.json", "utf8")),
  root = JSON.parse(await readFile(index + "/root.json", "utf8")),
  wanted = new Set<string>(common.flatMap((p: any) => [p.a, p.b])),
  ids = new Map<string, number>();
if (
  vocab.generation !== sourceMetadata.baseGeneration ||
  sourceStatistics.baseGeneration !== vocab.generation
)
  throw Error("Pair source generation mismatch");
if (
  root.count !== sourceMetadata.documents ||
  root.count !== router.metadata.documents ||
  router.metadata.baseGeneration !== root.generation
)
  throw Error("Pair document count mismatch");
if (root.generation !== vocab.generation) {
  for (const stage of ["documents", "terms"]) {
    const receipt = JSON.parse(
      await readFile(index + "/" + stage + "-report.json", "utf8"),
    );
    if (
      receipt.sourceGeneration !== vocab.generation ||
      receipt.documents !== root.count
    )
      throw Error(
        "Pair source requires an order/ID-preserving conversion receipt",
      );
  }
}
for (let i = 0; i < vocab.words.length; i++)
  if (wanted.has(vocab.words[i])) ids.set(vocab.words[i], i);
const plans: any[] = [];
for (const p of common) {
  const leaf = router.route(p.a, p.b);
  if (!leaf) throw Error("Missing source pair membership");
  const file = await open(index + `/objects/pairs-${leaf.object}.bin`, "r"),
    raw = new Uint8Array(leaf.bytes);
  try {
    let at = 0;
    while (at < raw.length) {
      const { bytesRead } = await file.read(
        raw,
        at,
        raw.length - at,
        leaf.offset + at,
      );
      if (!bytesRead) throw Error("Truncated source membership packet");
      at += bytesRead;
    }
  } finally {
    await file.close();
  }
  const packet = new PairMembershipPacket(raw),
    r = packet.lookup(p.a, p.b, router.metadata.documents);
  if (!r) throw Error("Missing selected pair in authoritative packet");
  if (r.a !== ids.get(p.a) || r.b !== ids.get(p.b))
    throw Error("Pair term IDs differ from occurrence source");
  const occ = r.bodyOccurrences + r.titleOccurrences,
    estimate = pairPacketByteBound(r.df, occ),
    work = r.df * 512,
    ratio = work / estimate;
  if (estimate < budget / 4)
    plans.push({
      ...p,
      id: plans.length,
      aId: ids.get(p.a),
      bId: ids.get(p.b),
      occ,
      bodyOccurrences: r.bodyOccurrences,
      titleOccurrences: r.titleOccurrences,
      estimate,
      ratio,
    });
}
plans.sort((a, b) => b.ratio - a.ratio || a.aId - b.aId || a.bId - b.bId);
let reserved = 0;
const selected = plans.filter((p) => {
  if (reserved + p.estimate > budget) return false;
  reserved += p.estimate;
  return true;
});
const generation = createHash("sha256")
    .update(
      "exact-phrases-1:" +
        sourceStatistics.generation +
        ":" +
        root.generation +
        ":" +
        JSON.stringify(selected),
    )
    .digest("hex"),
  files = new Map<string, any[]>();
for (const p of selected) {
  const ns = namespaces.get(p.a) ?? 0,
    h = ns
      ? pairStringHash(p.b)
      : pairHash(pairStringHash(p.a), pairStringHash(p.b)),
    name = `${ns}-${ns ? 2 : 8}-${h >>> (ns ? 30 : 24)}.bin`;
  if (!files.has(name)) files.set(name, []);
  files.get(name)!.push(p);
}
console.log(
  "Selected",
  selected.length,
  "pairs; reserved bound",
  reserved,
  "bytes; source partitions",
  files.size,
);
if (process.argv.includes("--verify-selection")) {
  const existing = JSON.parse(
    await readFile(output + "/position-selection.json", "utf8"),
  );
  if (
    existing.generation !== generation ||
    JSON.stringify(existing.selected) !== JSON.stringify(selected)
  )
    throw Error("Construction selection differs from existing generation");
  console.log(
    "Existing selection and generation match current membership data",
  );
  process.exit(0);
}
await writeFile(
  output + "/position-selection.json",
  JSON.stringify(
    {
      sourceGeneration: sourceMetadata.baseGeneration,
      generation,
      budget,
      reserved,
      selected,
    },
    null,
    2,
  ),
);
let readBytes = 0,
  matched = 0;
for (const [name, ps] of files) {
  const lookup = new Map<number, Map<number, any>>(),
    buffers = new Map<number, Buffer[]>();
  for (const p of ps) {
    if (!lookup.has(p.aId)) lookup.set(p.aId, new Map());
    lookup.get(p.aId)!.set(p.bId, p);
    await writeFile(output + `/position-scratch/${p.id}.bin`, new Uint8Array());
  }
  const file = await open(input + "/scratch/" + name, "r"),
    buffer = Buffer.allocUnsafe(24 * 65536);
  try {
    for (;;) {
      const { bytesRead: n } = await file.read(buffer, 0, buffer.length, null);
      if (!n) break;
      if (n % 24) throw Error("Truncated occurrence partition");
      readBytes += n;
      for (let at = 0; at < n; at += 24) {
        const p = lookup
          .get(buffer.readUInt32LE(at))
          ?.get(buffer.readUInt32LE(at + 4));
        if (p) {
          let b = buffers.get(p.id);
          if (!b) buffers.set(p.id, (b = []));
          b.push(buffer.subarray(at + 8, at + 24));
          matched++;
        }
      }
      for (const [id, parts] of buffers) {
        await appendFile(
          output + `/position-scratch/${id}.bin`,
          Buffer.concat(parts),
        );
      }
      buffers.clear();
    }
  } finally {
    await file.close();
  }
  console.log("Partition", name, readBytes, matched);
}
const objects: { id: number; bytes: number; sha256: string }[] = [],
  store = new PacketObjects(async (id, data) => {
    await writeFile(output + `/objects/positions-${id}.bin`, data);
    objects.push({
      id,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }, 10000),
  catalog: any[] = [];
function* rows(
  path: string,
  counts: {
    df: number;
    bodyDf: number;
    titleDf: number;
    bodyOccurrences: number;
    titleOccurrences: number;
  },
): Generator<PairColumnRow> {
  const fd = openSync(path, "r"),
    raw = Buffer.allocUnsafe(16 * 65536);
  let current: PairColumnRow | undefined;
  const empty = () => ({
    positions: [] as number[],
    previous: [] as number[],
    next: [] as number[],
  });
  try {
    for (;;) {
      const n = readSync(fd, raw, 0, raw.length, null);
      if (!n) break;
      if (n % 16) throw Error("Truncated positional run");
      for (let at = 0; at < n; at += 16) {
        const df = raw.readUInt32LE(at),
          doc = df >>> 1;
        if (current && current.doc !== doc) {
          counts.df++;
          counts.bodyDf += current.body.positions.length ? 1 : 0;
          counts.titleDf += current.title.positions.length ? 1 : 0;
          yield current;
          current = undefined;
        }
        current ??= { doc, body: empty(), title: empty() };
        const c = df & 1 ? current.title : current.body;
        if (df & 1) counts.titleOccurrences++;
        else counts.bodyOccurrences++;
        (c.positions as number[]).push(raw.readUInt32LE(at + 4));
        (c.previous as number[]).push(raw.readUInt32LE(at + 8));
        (c.next as number[]).push(raw.readUInt32LE(at + 12));
      }
    }
    if (current) {
      counts.df++;
      counts.bodyDf += current.body.positions.length ? 1 : 0;
      counts.titleDf += current.title.positions.length ? 1 : 0;
      yield current;
    }
  } finally {
    closeSync(fd);
  }
}
for (const p of selected) {
  const path = output + `/position-scratch/${p.id}.bin`,
    chunks = [],
    counts = {
      df: 0,
      bodyDf: 0,
      titleDf: 0,
      bodyOccurrences: 0,
      titleOccurrences: 0,
    };
  let bytes = 0;
  for (const chunk of pairPositionChunks(p.aId, p.bId, rows(path, counts))) {
    chunks.push({
      first: chunk.first,
      last: chunk.last,
      ...(await store.append(chunk.data)),
      length: chunk.data.length,
    });
    bytes += chunk.data.length;
  }
  for (const key of Object.keys(counts) as (keyof typeof counts)[])
    if (counts[key] !== p[key])
      throw Error(
        "Incomplete pair coverage: " +
          p.a +
          " " +
          p.b +
          " " +
          key +
          " " +
          counts[key] +
          " != " +
          p[key],
      );
  const directory = encodePairPositionDirectory(
    p.aId,
    p.bId,
    generation,
    chunks,
  );
  await writeFile(output + `/positions-${p.id}.directory`, directory);
  catalog.push({
    ...p,
    bytes,
    chunks: chunks.length,
    directory: `positions-${p.id}.directory`,
  });
  await rm(path);
}
await store.flush();
const report = {
  sourceGeneration: sourceMetadata.baseGeneration,
  generation,
  budget,
  reserved,
  readBytes,
  matched,
  bytes: catalog.reduce((n, p) => n + p.bytes, 0),
  directoryBytes: (
    await Promise.all(catalog.map((p) => readFile(output + "/" + p.directory)))
  ).reduce((n, b) => n + b.length, 0),
  objects,
  catalog,
  seconds: (performance.now() - started) / 1000,
};
await writeFile(
  output + "/positions-report.json",
  JSON.stringify(report, null, 2),
);
const descriptors = await Promise.all(
  catalog.map(async (p) => ({
    ...p,
    directory: completePairRanges(
      new PairPositionDirectory(await readFile(output + "/" + p.directory)),
    ),
  })),
);
const binary = encodeExactPhraseDirectory(
  {
    generation,
    baseGeneration: root.generation,
    documents: root.count,
    objects,
  },
  descriptors,
);
new ExactPhraseDirectory(binary);
await writeFile(output + "/exact-phrases.bin", binary);
// A deployable local view shares immutable base assets instead of duplicating
// the corpus or requiring a legacy runtime. New positional objects stay owned
// by this generation. Never replace an existing output file with a link.
const baseAssets = [
  "root.json",
  "directory.bin",
  "documents.bin",
  "router.bin",
  "presence.json",
  "presence",
  "metadata",
  "packs",
  "documents-report.json",
  "terms-report.json",
];
async function link(from: string, to: string) {
  if (
    await lstat(to).then(
      () => true,
      (e) => {
        if (e.code !== "ENOENT") throw e;
        return false;
      },
    )
  )
    return;
  if (
    await lstat(from).then(
      () => true,
      (e) => {
        if (e.code !== "ENOENT") throw e;
        return false;
      },
    )
  )
    await symlink(resolve(from), to);
}
for (const name of baseAssets)
  await link(index + "/" + name, output + "/" + name);
for (const name of await readdir(index + "/objects"))
  await link(index + "/objects/" + name, output + "/objects/" + name);
console.log(
  "Complete",
  catalog.length,
  "pairs",
  report.bytes,
  "bytes",
  report.seconds,
  "seconds",
);
