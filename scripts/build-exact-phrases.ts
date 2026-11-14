/** Complete prev/next coverage: retain existing inline context and materialize
 * every other pair. No vocabulary, rank or encoded-size selection cutoff. */
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  open,
  stat,
  symlink,
  lstat,
} from "node:fs/promises";
import { serialize, deserialize } from "node:v8";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  PairRouter,
  encodePairRouter,
  type PairLeaf,
} from "../src/columnar/pair-router.js";
import {
  PAIR_PACKET_MAGIC,
  pairHash,
  pairStringHash,
} from "../src/columnar/pair-membership.js";
import { encodeVarints } from "../src/columnar/compact-integers.js";
import { concat, view } from "../src/columnar/format.js";
import { pairPositionChunks } from "../src/columnar/pair-positions.js";
import type { PairColumnRow } from "../src/columnar/pair-packet.js";
import { PacketObjects } from "../src/columnar/packet-objects.js";
import {
  encodeCompletePairRanges,
  type ExactPairRanges,
} from "../src/columnar/pair-ranges.js";
import { encodeExactPhraseDirectory } from "../src/columnar/exact-phrase-directory.js";

const [input, index, output, stage = "all"] = process.argv.slice(2);
if (!output || !["all", "catalog", "positions", "attach"].includes(stage))
  throw Error(
    "Usage: build-exact-phrases.ts COMPLETE_PAIRS BASE_INDEX OUTPUT [all|catalog|positions|attach]",
  );
await mkdir(output + "/objects", { recursive: true });
await mkdir(output + "/context-checkpoints", { recursive: true });
const started = performance.now(),
  source = JSON.parse(await readFile(input + "/specification.json", "utf8")),
  statistics = JSON.parse(await readFile(input + "/statistics.json", "utf8")),
  root = JSON.parse(await readFile(index + "/root.json", "utf8")),
  routerRaw = await readFile(index + "/router.bin"),
  router = new PairRouter(routerRaw),
  vocabulary = deserialize(await readFile(input + "/vocabulary.bin")),
  generation = createHash("sha256")
    .update(
      "complete-pair-context-reserved-2:" +
        statistics.generation +
        ":" +
        root.generation +
        ":32768",
    )
    .digest("hex");
if (
  source.baseGeneration !== vocabulary.generation ||
  statistics.baseGeneration !== vocabulary.generation ||
  source.documents !== root.count ||
  router.metadata.baseGeneration !== root.generation
)
  throw Error("Construction source generation mismatch");
if (root.generation !== vocabulary.generation)
  for (const name of ["documents", "terms"]) {
    const r = JSON.parse(
      await readFile(index + "/" + name + "-report.json", "utf8"),
    );
    if (
      r.sourceGeneration !== vocabulary.generation ||
      r.documents !== root.count
    )
      throw Error("Missing order/ID-preserving conversion receipt");
  }
const namespaces = new Map<string, number>(
  source.namespaces.map((s: string, i: number) => [s, i + 1]),
);
type Plan = {
  id: number;
  aId: number;
  bId: number;
  df: number;
  bodyDf: number;
  titleDf: number;
  bodyOccurrences: number;
  titleOccurrences: number;
  occ: number;
  partition: string;
  ranges: ExactPairRanges["ranges"];
  bytes: number;
};
type ObjectIdentity = { id: number; bytes: number; sha256: string };
const packets = [...router.packets()].sort(
    (a, b) => a.object - b.object || a.offset - b.offset,
  ),
  h = new Uint32Array(11);
function header(data: Uint8Array, from: number, length: number) {
  const end = from + length;
  if (length < 12 || data[from++] !== 4)
    throw Error("Invalid membership record");
  for (let i = 0; i < 11; i++) {
    let value = 0,
      scale = 1,
      done = false;
    for (let j = 0; j < 5 && from < end; j++) {
      const b = data[from++];
      value += (b & 127) * scale;
      if (!(b & 128)) {
        done = true;
        break;
      }
      scale *= 128;
    }
    if (!done || value > 0xffffffff)
      throw Error("Invalid membership header integer");
    h[i] = value;
  }
  if (from + h[7] + h[8] + h[9] !== end || h[10] > 15)
    throw Error("Invalid membership spans");
  return from;
}
async function* sourcePackets() {
  let object = -1,
    bytes = new Uint8Array();
  for (const p of packets) {
    if (object !== p.object) {
      object = p.object;
      bytes = await readFile(index + `/objects/pairs-${object}.bin`);
    }
    const raw = bytes.subarray(p.offset, p.offset + p.bytes),
      v = view(raw);
    if (
      v.getUint32(0, true) !== PAIR_PACKET_MAGIC ||
      v.getUint32(4, true) !== p.pairs ||
      v.getUint32(12, true) !== raw.length
    )
      throw Error("Invalid source packet");
    yield { p, raw, v };
  }
}
let catalog: any;
if (stage === "catalog" || stage === "all") {
  const plans: Plan[] = [],
    counts = {
      pairs: 0,
      inlinePairs: 0,
      externalPairs: 0,
      bodyOccurrences: 0,
      titleOccurrences: 0,
      inlineOccurrences: 0,
      externalOccurrences: 0,
      documentMemberships: 0,
    };
  let packetCount = 0;
  for await (const { p, raw, v } of sourcePackets()) {
    for (let i = 0; i < p.pairs; i++) {
      const at = 16 + i * 16,
        from = v.getUint32(at + 8, true),
        length = v.getUint32(at + 12, true),
        body = header(raw, from, length),
        context = body + h[7] + h[8];
      counts.pairs++;
      counts.bodyOccurrences += h[5];
      counts.titleOccurrences += h[6];
      counts.documentMemberships += h[2];
      if (h[9] > 0 && v.getUint32(context, true) === 0x31584343) {
        counts.inlinePairs++;
        counts.inlineOccurrences += h[5] + h[6];
        continue;
      }
      const aId = h[0],
        bId = h[1],
        a = vocabulary.words[aId],
        b = vocabulary.words[bId],
        ns = namespaces.get(a) ?? 0,
        hash = ns
          ? pairStringHash(b)
          : pairHash(pairStringHash(a), pairStringHash(b));
      if (a === undefined || b === undefined)
        throw Error("Unknown pair term ID");
      const partition = `${ns}-${ns ? 2 : 8}-${hash >>> (ns ? 30 : 24)}.bin`;
      plans.push({
        id: 0,
        aId,
        bId,
        df: h[2],
        bodyDf: h[3],
        titleDf: h[4],
        bodyOccurrences: h[5],
        titleOccurrences: h[6],
        occ: h[5] + h[6],
        partition,
        ranges: [],
        bytes: 0,
      });
      counts.externalPairs++;
      counts.externalOccurrences += h[5] + h[6];
    }
    if (++packetCount % 10000 === 0)
      console.log(
        "Catalog",
        packetCount,
        "packets",
        counts.pairs,
        "pairs",
        plans.length,
        "external",
      );
  }
  for (const k of [
    "pairs",
    "bodyOccurrences",
    "titleOccurrences",
    "documentMemberships",
  ] as const)
    if (counts[k] !== statistics[k])
      throw Error("Pair coverage statistics mismatch: " + k);
  plans.sort((a, b) => a.aId - b.aId || a.bId - b.bId);
  plans.forEach((p, i) => (p.id = i));
  catalog = {
    generation,
    baseGeneration: root.generation,
    sourceGeneration: source.baseGeneration,
    counts,
    plans,
  };
  await writeFile(output + "/context-catalog.bin", serialize(catalog));
  await writeFile(
    output + "/context-coverage.json",
    JSON.stringify(
      {
        ...catalog,
        plans: undefined,
        seconds: (performance.now() - started) / 1000,
      },
      null,
      2,
    ),
  );
  console.log("Catalog complete", JSON.stringify(counts));
} else catalog = deserialize(await readFile(output + "/context-catalog.bin"));
if (catalog.generation !== generation)
  throw Error("Catalog generation mismatch");
const plans: Plan[] = catalog.plans;
let objects: ObjectIdentity[] = [];
function* rows(raw: Uint32Array, p: Plan) {
  let row: PairColumnRow | undefined,
    previous = -1;
  const counts = {
      df: 0,
      bodyDf: 0,
      titleDf: 0,
      bodyOccurrences: 0,
      titleOccurrences: 0,
    },
    empty = () => ({
      positions: [] as number[],
      previous: [] as number[],
      next: [] as number[],
    });
  for (let at = 0; at < raw.length; at += 4) {
    const df = raw[at],
      doc = df >>> 1;
    if (df < previous) throw Error("Source pair occurrences out of order");
    previous = df;
    if (row && row.doc !== doc) {
      counts.df++;
      counts.bodyDf += row.body.positions.length ? 1 : 0;
      counts.titleDf += row.title.positions.length ? 1 : 0;
      yield row;
      row = undefined;
    }
    row ??= { doc, body: empty(), title: empty() };
    const c = df & 1 ? row.title : row.body;
    if (df & 1) counts.titleOccurrences++;
    else counts.bodyOccurrences++;
    (c.positions as number[]).push(raw[at + 1]);
    (c.previous as number[]).push(raw[at + 2]);
    (c.next as number[]).push(raw[at + 3]);
  }
  if (row) {
    counts.df++;
    counts.bodyDf += row.body.positions.length ? 1 : 0;
    counts.titleDf += row.title.positions.length ? 1 : 0;
    yield row;
  }
  for (const k of Object.keys(counts) as (keyof typeof counts)[])
    if (counts[k] !== p[k])
      throw Error(
        "Incomplete context coverage: " +
          p.id +
          " " +
          k +
          " " +
          counts[k] +
          " != " +
          p[k],
      );
}
if (stage === "positions" || stage === "all") {
  const partitions = new Map<string, Plan[]>();
  for (const p of plans) {
    if (!partitions.has(p.partition)) partitions.set(p.partition, []);
    partitions.get(p.partition)!.push(p);
  }
  const sorted = [...partitions].sort(([a], [b]) => a.localeCompare(b));
  let reserved = 10000;
  const assigned = sorted.map(([name, ps], ordinal) => {
    const firstObject = reserved;
    // More than the maximum packet/header encoding per source occurrence.
    // Reservations allocate IDs only, never disk bytes or runtime arrays.
    reserved += Math.ceil(
      ps.reduce((n, p) => n + 256 * p.occ + 64 * p.df + 4096, 0) /
        (32 * 1048576),
    );
    return { name, ps, ordinal, firstObject, end: reserved };
  });
  const shard = process.env.CWS_CONTEXT_SHARD?.split("/").map(Number),
    concurrency = Number(process.env.CWS_CONTEXT_CONCURRENCY ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw Error("Context concurrency must be 1..8");
  if (!shard && concurrency > 1) {
    await Promise.all(
      Array.from(
        { length: concurrency },
        (_, i) =>
          new Promise<void>((yes, no) => {
            const child = spawn(
              process.execPath,
              [
                "--import",
                "tsx",
                import.meta.filename,
                input,
                index,
                output,
                "positions",
              ],
              {
                stdio: "inherit",
                env: {
                  ...process.env,
                  CWS_CONTEXT_SHARD: i + "/" + concurrency,
                },
              },
            );
            child.once("error", no);
            child.once("exit", (code) =>
              code === 0
                ? yes()
                : no(Error("Context shard " + i + " exited " + code)),
            );
          }),
      ),
    );
  }
  let nextObject = 10000,
    readBytes = 0,
    done = 0,
    encoded = 0,
    peakPartitionBytes = 0;
  for (const {
    name,
    ps,
    ordinal,
    firstObject: assignedObject,
    end: reservedEnd,
  } of assigned) {
    if (shard && ordinal % shard[1] !== shard[0]) continue;
    nextObject = assignedObject;
    const checkpoint = output + "/context-checkpoints/" + name,
      old = await readFile(checkpoint).then(
        (b) => deserialize(b),
        (e) => {
          if (e.code !== "ENOENT") throw e;
          return undefined;
        },
      );
    if (old) {
      if (old.generation !== generation || old.firstObject !== nextObject)
        throw Error("Checkpoint identity mismatch");
      for (const o of old.objects)
        if (
          (await stat(output + `/objects/positions-${o.id}.bin`)).size !==
          o.bytes
        )
          throw Error("Checkpoint object missing");
      for (const p of old.plans) Object.assign(plans[p.id], p);
      objects.push(...old.objects);
      encoded += old.bytes;
      readBytes += old.readBytes;
      peakPartitionBytes = Math.max(peakPartitionBytes, old.peakPartitionBytes);
      done += ps.length;
      continue;
    }
    const firstObject = nextObject,
      identities: ObjectIdentity[] = [],
      lookup = new Map<
        number,
        Map<number, { p: Plan; at: number; end: number }>
      >(),
      total = ps.reduce((n, p) => n + p.occ, 0),
      data = new Uint32Array(total * 4);
    peakPartitionBytes = Math.max(peakPartitionBytes, data.byteLength);
    let offset = 0;
    for (const p of ps) {
      if (!lookup.has(p.aId)) lookup.set(p.aId, new Map());
      lookup.get(p.aId)!.set(p.bId, { p, at: offset, end: offset + p.occ * 4 });
      offset += p.occ * 4;
    }
    const file = await open(input + "/scratch/" + name, "r"),
      buffer = Buffer.allocUnsafe(24 * 65536),
      words = new Uint32Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.length / 4,
      );
    try {
      for (;;) {
        const { bytesRead: n } = await file.read(
          buffer,
          0,
          buffer.length,
          null,
        );
        if (!n) break;
        if (n % 24) throw Error("Truncated occurrence partition");
        readBytes += n;
        for (let at = 0; at < n / 4; at += 6) {
          const target = lookup.get(words[at])?.get(words[at + 1]);
          if (!target) continue;
          if (target.at >= target.end)
            throw Error("Pair occurrence count exceeds membership source");
          data[target.at++] = words[at + 2];
          data[target.at++] = words[at + 3];
          data[target.at++] = words[at + 4];
          data[target.at++] = words[at + 5];
        }
      }
    } finally {
      await file.close();
    }
    const store = new PacketObjects(async (id, bytes) => {
      await writeFile(output + `/objects/positions-${id}.bin`, bytes);
      identities.push({
        id,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      nextObject = id + 1;
    }, nextObject);
    offset = 0;
    for (const p of ps) {
      const target = lookup.get(p.aId)!.get(p.bId)!;
      if (target.at !== target.end) throw Error("Missing pair occurrences");
      p.ranges = [];
      p.bytes = 0;
      for (const chunk of pairPositionChunks(
        p.aId,
        p.bId,
        rows(data.subarray(offset, offset + p.occ * 4), p),
      )) {
        const r = {
            ...(await store.append(chunk.data)),
            length: chunk.data.length,
          },
          last = p.ranges.at(-1);
        if (
          last &&
          last.object === r.object &&
          last.offset + last.length === r.offset
        )
          last.length += r.length;
        else p.ranges.push(r);
        p.bytes += r.length;
      }
      offset += p.occ * 4;
      encoded += p.bytes;
      done++;
    }
    await store.flush();
    if (nextObject > reservedEnd)
      throw Error("Context object ID reservation exhausted");
    objects.push(...identities);
    await writeFile(
      checkpoint,
      serialize({
        generation,
        firstObject,
        nextObject,
        objects: identities,
        plans: ps,
        bytes: ps.reduce((n, p) => n + p.bytes, 0),
        readBytes: (await stat(input + "/scratch/" + name)).size,
        peakPartitionBytes: data.byteLength,
      }),
    );
    console.log(
      "Contexts",
      name,
      done,
      "/",
      plans.length,
      "pairs",
      encoded,
      "bytes",
      Math.round((performance.now() - started) / 1000),
      "seconds",
    );
  }
  if (shard) process.exit(0);
  await writeFile(
    output + "/context-complete.bin",
    serialize({ ...catalog, objects, plans }),
  );
  await writeFile(
    output + "/positions-report.json",
    JSON.stringify(
      {
        generation,
        sourceGeneration: source.baseGeneration,
        baseGeneration: root.generation,
        counts: catalog.counts,
        bytes: encoded,
        readBytes,
        peakPartitionBytes,
        objects,
        seconds: (performance.now() - started) / 1000,
      },
      null,
      2,
    ),
  );
  console.log("All external pair contexts complete", plans.length, encoded);
}
if (stage === "attach" || stage === "all") {
  const complete = deserialize(
    await readFile(output + "/context-complete.bin"),
  );
  if (complete.generation !== generation)
    throw Error("Complete positions generation mismatch");
  objects = complete.objects;
  const fullPlans: Plan[] = complete.plans,
    byId = new Map<number, Map<number, Plan>>();
  for (const p of fullPlans) {
    if (!byId.has(p.aId)) byId.set(p.aId, new Map());
    byId.get(p.aId)!.set(p.bId, p);
  }
  const rv = view(routerRaw),
    json = rv.getUint32(4, true),
    n = rv.getUint32(8, true),
    l = rv.getUint32(12, true),
    base = 20 + json,
    table = base + n * 8,
    nodes: [number, number][] = Array.from({ length: n }, (_, i) => [
      rv.getInt32(base + i * 8, true),
      rv.getInt32(base + i * 8 + 4, true),
    ]),
    leaves: PairLeaf[] = Array.from({ length: l }, (_, i) => ({
      object: rv.getUint32(table + i * 16, true),
      offset: rv.getUint32(table + i * 16 + 4, true),
      bytes: rv.getUint32(table + i * 16 + 8, true),
      pairs: rv.getUint32(table + i * 16 + 12, true),
      namespace: 0,
      bits: 0,
      prefix: 0,
      crc32: 0,
    })),
    leafMap = new Map(leaves.map((p) => [p.object + ":" + p.offset, p])),
    store = new PacketObjects(async (id, bytes) =>
      writeFile(output + `/objects/pairs-${id}.bin`, bytes),
    );
  let patched = 0,
    packetCount = 0;
  for await (const { p, raw, v } of sourcePackets()) {
    const head = raw.slice(0, v.getUint32(8, true)),
      hv = view(head),
      records: Uint8Array[] = [];
    let offset = head.length;
    for (let i = 0; i < p.pairs; i++) {
      const at = 16 + i * 16,
        from = v.getUint32(at + 8, true),
        length = v.getUint32(at + 12, true),
        body = header(raw, from, length),
        plan = byId.get(h[0])?.get(h[1]);
      let data: Uint8Array;
      if (plan) {
        const context = encodeCompletePairRanges({
            a: plan.aId,
            b: plan.bId,
            generation,
            ranges: plan.ranges,
          }),
          values = Array.from(h);
        values[9] = context.length;
        data = concat([
          Uint8Array.of(4),
          encodeVarints(values),
          raw.subarray(body, body + h[7] + h[8]),
          context,
        ]);
        patched++;
      } else data = raw.subarray(from, from + length);
      hv.setUint32(at + 8, offset, true);
      hv.setUint32(at + 12, data.length, true);
      offset += data.length;
      records.push(data);
    }
    hv.setUint32(12, offset, true);
    const encoded = concat([head, ...records]);
    Object.assign(
      leafMap.get(p.object + ":" + p.offset)!,
      await store.append(encoded),
      { bytes: encoded.length },
    );
    if (++packetCount % 10000 === 0)
      console.log(
        "Attached",
        packetCount,
        "packets",
        patched,
        "external pairs",
      );
  }
  await store.flush();
  if (patched !== fullPlans.length)
    throw Error("Incomplete context attachment");
  await writeFile(
    output + "/router.bin",
    encodePairRouter(
      {
        ...router.metadata,
        generation,
        positionObjects: objects,
        completeContext: true,
      },
      nodes,
      leaves,
      routerRaw.subarray(table + l * 16),
    ),
  );
  const presence = JSON.parse(await readFile(index + "/presence.json", "utf8"));
  presence.generation = generation;
  await writeFile(output + "/presence.json", JSON.stringify(presence));
  const hot = JSON.parse(await readFile(input + "/common-pairs.json", "utf8")),
    wanted = new Set(hot.map((p: any) => p.a + "\0" + p.b));
  await writeFile(
    output + "/exact-phrases.bin",
    encodeExactPhraseDirectory(
      {
        generation,
        baseGeneration: root.generation,
        documents: root.count,
        objects,
      },
      fullPlans
        .filter((p) =>
          wanted.has(vocabulary.words[p.aId] + "\0" + vocabulary.words[p.bId]),
        )
        .map((p) => ({
          ...p,
          a: vocabulary.words[p.aId],
          b: vocabulary.words[p.bId],
          directory: { a: p.aId, b: p.bId, generation, ranges: p.ranges },
        })),
    ),
  );
  const link = async (from: string, to: string) => {
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
    await symlink(resolve(from), to);
  };
  for (const name of [
    "root.json",
    "directory.bin",
    "documents.bin",
    "metadata",
    "presence",
    "packs",
    "documents-report.json",
    "terms-report.json",
  ])
    await link(index + "/" + name, output + "/" + name);
  for (const name of await readdir(index + "/objects"))
    await link(index + "/objects/" + name, output + "/objects/" + name);
  await writeFile(
    output + "/complete-context-report.json",
    JSON.stringify(
      {
        generation,
        baseGeneration: root.generation,
        coverage: catalog.counts,
        externalPairs: patched,
        packets: packetCount,
        positionObjects: objects.length,
        seconds: (performance.now() - started) / 1000,
      },
      null,
      2,
    ),
  );
  console.log(
    "Complete pair context index ready",
    JSON.stringify(catalog.counts),
  );
}
