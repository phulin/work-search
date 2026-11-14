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
} from "node:fs/promises";
import { openSync, readSync, closeSync } from "node:fs";
import { deserialize } from "node:v8";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  pairPositionChunks,
  encodePairPositionDirectory,
} from "../src/columnar/pair-positions.js";
import { pairStringHash, pairHash } from "../src/columnar/pair-membership.js";
import { PacketObjects } from "../src/columnar/packet-objects.js";
import {
  type PairColumnRow,
  pairPacketByteBound,
} from "../src/columnar/pair-packet.js";
const [input, output, control, budgetArg = "256"] = process.argv.slice(2);
if (!control)
  throw Error(
    "Usage: build-pair-positions.ts COMPLETE_PAIRS OUTPUT FROZEN_SOURCE [BUDGET_MIB]",
  );
await mkdir(output + "/position-scratch", { recursive: true });
await mkdir(output + "/objects", { recursive: true });
const budget = Number(budgetArg) * 1048576,
  started = performance.now(),
  load = (n: string) =>
    import(pathToFileURL(resolve(control + "/src/columnar/" + n + ".ts")).href),
  { PairRouter, pairObjectKey } = await load("pair-router"),
  { PairMembershipPacket } = await load("pair-membership"),
  router = new PairRouter(await readFile(input + "/router.bin")),
  vocab = deserialize(await readFile(input + "/vocabulary.bin")),
  common = JSON.parse(await readFile(input + "/common-pairs.json", "utf8")),
  wanted = new Set<string>(common.flatMap((p: any) => [p.a, p.b])),
  ids = new Map<string, number>();
if (vocab.generation !== router.metadata.baseGeneration)
  throw Error("Pair source generation mismatch");
for (let i = 0; i < vocab.words.length; i++)
  if (wanted.has(vocab.words[i])) ids.set(vocab.words[i], i);
const plans: any[] = [];
for (const p of common) {
  const leaf = router.route(p.a, p.b),
    key = pairObjectKey(router.metadata.generation, leaf),
    packet = new PairMembershipPacket(
      await readFile(input + "/objects/" + key.split("/")[1]),
    ),
    r = packet.lookup(p.a, p.b, router.metadata.documents),
    occ = r.bodyOccurrences + r.titleOccurrences,
    estimate = pairPacketByteBound(r.df, occ),
    work = r.df * 512,
    ratio = work / estimate;
  if (!r.context && estimate < budget / 4)
    plans.push({
      ...p,
      id: plans.length,
      aId: ids.get(p.a),
      bId: ids.get(p.b),
      occ,
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
    .update("compact-pairs-4:" + router.metadata.generation)
    .digest("hex"),
  files = new Map<string, any[]>();
for (const p of selected) {
  const ns = router.route(p.a, p.b).namespace,
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
await writeFile(
  output + "/position-selection.json",
  JSON.stringify(
    {
      sourceGeneration: router.metadata.baseGeneration,
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
  }),
  catalog: any[] = [];
function* rows(path: string): Generator<PairColumnRow> {
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
          yield current;
          current = undefined;
        }
        current ??= { doc, body: empty(), title: empty() };
        const c = df & 1 ? current.title : current.body;
        (c.positions as number[]).push(raw.readUInt32LE(at + 4));
        (c.previous as number[]).push(raw.readUInt32LE(at + 8));
        (c.next as number[]).push(raw.readUInt32LE(at + 12));
      }
    }
    if (current) yield current;
  } finally {
    closeSync(fd);
  }
}
for (const p of selected) {
  const path = output + `/position-scratch/${p.id}.bin`,
    chunks = [];
  let bytes = 0;
  for (const chunk of pairPositionChunks(p.aId, p.bId, rows(path))) {
    chunks.push({
      first: chunk.first,
      last: chunk.last,
      ...(await store.append(chunk.data)),
      length: chunk.data.length,
    });
    bytes += chunk.data.length;
  }
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
  sourceGeneration: router.metadata.baseGeneration,
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
console.log(
  "Complete",
  catalog.length,
  "pairs",
  report.bytes,
  "bytes",
  report.seconds,
  "seconds",
);
