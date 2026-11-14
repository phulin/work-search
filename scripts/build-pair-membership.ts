import { PacketObjects } from "../src/columnar/packet-objects.js";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  open,
  rename,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { serialize, deserialize } from "node:v8";
import { join, basename } from "node:path";
import { TermDirectory } from "../src/columnar/term-directory.js";
import { Reader } from "../src/columnar/storage.js";
import { DocumentPackage } from "../src/columnar/document-package.js";
import { view, type Root } from "../src/columnar/format.js";
import { LocalObjects } from "../bench/columnar/local-storage.js";
import {
  pairHash,
  pairStringHash,
  encodePairMembership,
  encodePairMembershipPacket,
} from "../src/columnar/pair-membership.js";
import {
  encodePairColumns,
  type PairColumnRow,
} from "../src/columnar/pair-packet.js";
import {
  encodePairRouter,
  pairObjectKey,
  NO_PAIR_PARTITION,
  type PairLeaf,
} from "../src/columnar/pair-router.js";
import { crc32 } from "../src/format/codec.js";

const [input, out, mode = "all"] = process.argv.slice(2),
  store = process.env.CWS_LOCAL_DATA ?? "work/columnar-local-data";
if (!input || !out || !["all", "partition", "pack"].includes(mode))
  throw Error(
    "Usage: build-pair-membership.ts INDEX_DIR OUTPUT_DIR [all|partition|pack]",
  );
const root: Root = JSON.parse(await readFile(input + "/root.json", "utf8")),
  target = Number(process.env.CWS_PAIR_PACKET_BYTES ?? 131072),
  contextLimit = Number(process.env.CWS_PAIR_CONTEXT_BYTES ?? 8192);
if (
  !Number.isSafeInteger(root.count) ||
  root.count < 1 ||
  root.count > 0x7fffffff ||
  !Number.isSafeInteger(target) ||
  target < 16384 ||
  !Number.isSafeInteger(contextLimit) ||
  contextLimit < 0
)
  throw Error(
    "Pair construction requires a valid generation and packet/context budgets",
  );
await mkdir(out, { recursive: true });
await mkdir(out + "/scratch", { recursive: true });
await mkdir(out + "/objects", { recursive: true });
const source = new LocalObjects(root, store),
  reader = new Reader(root, source),
  started = performance.now();
type Vocabulary = { generation: string; words: string[]; dfs: Uint32Array };
let vocabulary: Vocabulary;
try {
  vocabulary = deserialize(await readFile(out + "/vocabulary.bin"));
  if (vocabulary.generation !== root.generation)
    throw Error("Vocabulary generation mismatch");
} catch (e: any) {
  if (e.code !== "ENOENT") throw e;
  const words: string[] = [],
    dfs: number[] = [];
  let terms = 0,
    maxId = 0;
  for await (const [word, t] of new TermDirectory(
    await readFile(input + "/directory.bin"),
    root.count,
  ).allEntries(reader)) {
    if (words[t.id] !== undefined) throw Error("Duplicate normalized term ID");
    words[t.id] = word;
    dfs[t.id] = t.df;
    maxId = Math.max(maxId, t.id);
    terms++;
    if (terms % 100000 === 0) console.log("Vocabulary", terms);
  }
  if (terms !== root.directory!.terms || maxId !== terms)
    throw Error(
      `Pair vocabulary coverage mismatch: ${terms} terms, max ID ${maxId}`,
    );
  vocabulary = {
    generation: root.generation,
    words,
    dfs: Uint32Array.from(dfs),
  };
  await writeFile(out + "/vocabulary.bin", serialize(vocabulary));
}
const { words, dfs } = vocabulary,
  hashes = Uint32Array.from(words, (w) =>
    w === undefined ? 0 : pairStringHash(w),
  ),
  secondaryHashes = Uint32Array.from(words, (w) =>
    w === undefined ? 0 : pairStringHash("!" + w),
  ),
  ranks = Uint32Array.from({ length: words.length - 1 }, (_, i) => i + 1);
ranks.sort((a, b) => dfs[b] - dfs[a] || a - b);
const commonWords = [...ranks.subarray(0, 200)].map((id) => ({
    word: words[id],
    id,
    df: dfs[id],
  })),
  namespaces = [...ranks.subarray(0, 128)].map((id) => words[id]),
  namespaceIds = new Uint16Array(words.length),
  wordRanks = new Int32Array(words.length).fill(-1);
ranks.subarray(0, 128).forEach((id, i) => (namespaceIds[id] = i + 1));
ranks.subarray(0, 200).forEach((id, i) => (wordRanks[id] = i));
const route = (a: number, b: number) => ({
  ns: namespaceIds[a],
  hash: namespaceIds[a] ? hashes[b] : pairHash(hashes[a], hashes[b]),
});
const secondaryRoute = (a: number, b: number) =>
  namespaceIds[a]
    ? secondaryHashes[b]
    : pairHash(secondaryHashes[a], secondaryHashes[b]);
const encodingCode = createHash("sha256");
for (const file of [
  "scripts/build-pair-membership.ts",
  "src/columnar/pair-membership.ts",
  "src/columnar/pair-router.ts",
  "src/columnar/pair-packet.ts",
])
  encodingCode.update(await readFile(file));
const specification = {
  format: "complete-pair-membership-v1",
  encodingCode: encodingCode.digest("hex"),
  baseGeneration: root.generation,
  documents: root.count,
  targetBytes: target,
  contextBytes: contextLimit,
  namespaces,
  commonWords,
};
const generation = createHash("sha256")
  .update(JSON.stringify(specification))
  .digest("hex");
await writeFile(
  out + "/specification.json",
  JSON.stringify({ ...specification, generation }, null, 2),
);

if (mode !== "pack") {
  let complete = false;
  try {
    const receipt = JSON.parse(await readFile(out + "/partition.json", "utf8"));
    if (receipt.baseGeneration !== root.generation)
      throw Error("Partition identity mismatch");
    complete = true;
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  if (!complete) {
    // Only this task's incomplete partition output is disposable on restart.
    for (const name of await readdir(out + "/scratch"))
      await rm(out + "/scratch/" + name, { force: true });
    const buffers = new Map<string, { data: Buffer; at: number }>(),
      pending = new Set<Promise<void>>(),
      chains = new Map<string, Promise<void>>(),
      bufferBytes = 24 * 16384;
    let occurrences = 0,
      documents = 0;
    const presenceSeen = new Int32Array(400).fill(-1),
      presenceCounts = new Float64Array(400);
    const flush = (key: string, b: { data: Buffer; at: number }) => {
      if (!b.at) return;
      const p = (chains.get(key) ?? Promise.resolve())
        .then(() =>
          appendFile(`${out}/scratch/${key}.bin`, b.data.subarray(0, b.at)),
        )
        .finally(() => pending.delete(p));
      pending.add(p);
      chains.set(key, p);
    };
    const directory = await readFile(input + "/documents.bin"),
      v = view(directory),
      groups = v.getUint32(8, true);
    for (let group = 0; group < groups; group++) {
      while (pending.size >= 16) await Promise.race(pending);
      const at = 16 + group * 48,
        digest = directory.subarray(at + 16, at + 48).toString("hex"),
        data = await readFile(`${store}/objects/${digest}/plan-0.bin`),
        dv = view(data);
      for (let offset = 0; offset < data.length;) {
        const doc = dv.getUint32(offset + 4, true),
          length = dv.getUint32(offset + 60, true),
          pkg = new DocumentPackage(
            data.subarray(offset, offset + length),
            doc,
          );
        for (let field = 0; field < 2; field++) {
          const tokens = pkg.tokens(field);
          for (const token of tokens) {
            const rank = wordRanks[token];
            if (rank >= 0) {
              const index = rank * 2 + field;
              presenceCounts[index]++;
              if (presenceSeen[index] !== doc) {
                presenceSeen[index] = doc;
                const key = `presence-${index}`;
                let buffer = buffers.get(key);
                if (!buffer) {
                  buffer = { data: Buffer.allocUnsafe(32768), at: 0 };
                  buffers.set(key, buffer);
                }
                buffer.data.writeUInt32LE(doc, buffer.at);
                buffer.at += 4;
                if (buffer.at === buffer.data.length) {
                  flush(key, buffer);
                  buffers.set(key, { data: Buffer.allocUnsafe(32768), at: 0 });
                }
              }
            }
          }
          for (let p = 0; p + 1 < tokens.length; p++) {
            const a = tokens[p],
              b = tokens[p + 1];
            if (a >= words.length || b >= words.length)
              throw Error("Unknown package token");
            const { ns, hash } = route(a, b),
              bits = ns ? 2 : 8,
              prefix = hash >>> (32 - bits),
              key = `${ns}-${bits}-${prefix}`;
            let buffer = buffers.get(key);
            if (!buffer) {
              buffer = { data: Buffer.allocUnsafe(bufferBytes), at: 0 };
              buffers.set(key, buffer);
            }
            const o = buffer.at;
            buffer.data.writeUInt32LE(a, o);
            buffer.data.writeUInt32LE(b, o + 4);
            buffer.data.writeUInt32LE(doc * 2 + field, o + 8);
            buffer.data.writeUInt32LE(p, o + 12);
            buffer.data.writeUInt32LE(p ? tokens[p - 1] + 1 : 0, o + 16);
            buffer.data.writeUInt32LE(
              p + 2 < tokens.length ? tokens[p + 2] + 1 : 0,
              o + 20,
            );
            buffer.at += 24;
            occurrences++;
            if (buffer.at === bufferBytes) {
              flush(key, buffer);
              buffers.set(key, {
                data: Buffer.allocUnsafe(bufferBytes),
                at: 0,
              });
            }
          }
        }
        documents++;
        offset += length;
      }
      if (group % 100 === 0)
        console.log(
          "Partitioned",
          documents,
          "documents",
          occurrences,
          "occurrences",
          Math.round((performance.now() - started) / 1000),
          "s",
        );
    }
    for (const [key, b] of buffers) flush(key, b);
    await Promise.all(pending);
    if (documents !== root.count)
      throw Error("Incomplete pair source coverage");
    await writeFile(
      out + "/presence-counts.bin",
      new Uint8Array(presenceCounts.buffer),
    );
    await writeFile(
      out + "/partition.json",
      JSON.stringify(
        {
          baseGeneration: root.generation,
          documents,
          occurrences,
          recordBytes: 24,
          finishedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.log("Partition complete", documents, occurrences);
  }
}
if (mode === "partition") process.exit(0);

// Stable radix sorting of numeric row indices preserves source document and
// position order within each exact pair. Scratch memory is bounded per bucket.
function orderRows(data: Buffer) {
  const v = new Uint32Array(data.buffer, data.byteOffset, data.length / 4),
    n = data.length / 24;
  let a = Uint32Array.from({ length: n }, (_, i) => i),
    b = new Uint32Array(n);
  for (const column of [1, 0])
    for (let shift = 0; shift < 32; shift += 8) {
      const counts = new Uint32Array(256);
      for (let i = 0; i < n; i++)
        counts[(v[a[i] * 6 + column] >>> shift) & 255]++;
      let sum = 0;
      for (let i = 0; i < 256; i++) {
        const count = counts[i];
        counts[i] = sum;
        sum += count;
      }
      for (let i = 0; i < n; i++) {
        const row = a[i];
        b[counts[(v[row * 6 + column] >>> shift) & 255]++] = row;
      }
      [a, b] = [b, a];
    }
  return { v, order: a };
}
const packetObjects = new PacketObjects(async (id, data) => {
  await writeFile(out + "/objects/pairs-" + id + ".bin", data);
});
const nodes: [number, number][] = [],
  leaves: PairLeaf[] = [],
  roots = Array(namespaces.length + 1).fill(NO_PAIR_PARTITION),
  top: {
    a: number;
    b: number;
    df: number;
    bodyDf: number;
    titleDf: number;
    bytes: number;
  }[] = [],
  commonCommon = new Map<
    string,
    {
      a: number;
      b: number;
      df: number;
      bodyDf: number;
      titleDf: number;
      bytes: number;
    }
  >();
const report = {
  generation,
  baseGeneration: root.generation,
  documents: root.count,
  pairs: 0,
  documentMemberships: 0,
  fieldMemberships: 0,
  bodyOccurrences: 0,
  titleOccurrences: 0,
  membershipBytes: 0,
  recordBytes: 0,
  contextPairs: 0,
  contextBytes: 0,
  packets: 0,
  packetBytes: 0,
  oversizedPackets: 0,
  maxPacketBytes: 0,
  routerBytes: 0,
  groupBytes: new Float64Array(namespaces.length + 1),
  dfHistogram: new Float64Array(root.count + 1),
};
let doneBuckets = new Map<string, number>();
try {
  const saved = deserialize(await readFile(out + "/checkpoint.bin"));
  if (saved.generation !== generation)
    throw Object.assign(Error("Different packet configuration"), {
      code: "ENOENT",
    });
  nodes.push(...saved.nodes);
  leaves.push(...saved.leaves);
  top.push(...saved.top);
  for (const [key, value] of saved.commonCommon) commonCommon.set(key, value);
  Object.assign(report, saved.report);
  doneBuckets = saved.doneBuckets;
  console.log("Resuming", doneBuckets.size, "buckets", report.pairs, "pairs");
} catch (e: any) {
  if (e.code !== "ENOENT") throw e;
  for (const name of await readdir(out + "/objects"))
    await rm(join(out, "objects", name), { force: true });
}
async function checkpoint() {
  await writeFile(
    out + "/checkpoint.writing",
    serialize({
      generation,
      nodes,
      leaves,
      top,
      commonCommon,
      report,
      doneBuckets,
    }),
  );
  await rename(out + "/checkpoint.writing", out + "/checkpoint.bin");
}
function note(
  a: number,
  b: number,
  df: number,
  bodyDf: number,
  titleDf: number,
  bytes: number,
) {
  const entry = { a, b, df, bodyDf, titleDf, bytes };
  if (
    top.length < 2000 ||
    df > top[top.length - 1].df ||
    (df === top[top.length - 1].df &&
      (a < top[top.length - 1].a ||
        (a === top[top.length - 1].a && b < top[top.length - 1].b)))
  ) {
    let lo = 0,
      hi = top.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1,
        t = top[m];
      if (t.df > df || (t.df === df && (t.a < a || (t.a === a && t.b < b))))
        lo = m + 1;
      else hi = m;
    }
    top.splice(lo, 0, entry);
    if (top.length > 2000) top.pop();
  }
  if (
    wordRanks[a] >= 0 &&
    wordRanks[a] < 100 &&
    wordRanks[b] >= 0 &&
    wordRanks[b] < 100
  )
    commonCommon.set(`${a}:${b}`, entry);
}
type Entry = {
  a: string;
  b: string;
  data: Uint8Array;
  hash: number;
  hash2: number;
};
async function packetize(
  entries: Entry[],
  ns: number,
  bits: number,
  prefix: number,
  suffix = 0,
): Promise<number> {
  if (!entries.length) return NO_PAIR_PARTITION;
  const estimate =
    16 +
    entries.reduce(
      (n, e) =>
        n +
        16 +
        Buffer.byteLength(e.a) +
        1 +
        Buffer.byteLength(e.b) +
        e.data.length,
      0,
    );
  if (estimate > target && entries.length > 1 && bits < 64) {
    const children: [Entry[], Entry[]] = [[], []];
    for (const e of entries)
      children[
        ((bits < 32 ? e.hash : e.hash2) >>>
          (bits < 32 ? 31 - bits : 63 - bits)) &
          1
      ].push(e);
    const i = nodes.length;
    nodes.push([NO_PAIR_PARTITION, NO_PAIR_PARTITION]);
    nodes[i] = [
      await packetize(
        children[0],
        ns,
        bits + 1,
        bits < 32 ? prefix * 2 : prefix,
        bits < 32 ? 0 : suffix * 2,
      ),
      await packetize(
        children[1],
        ns,
        bits + 1,
        bits < 32 ? prefix * 2 + 1 : prefix,
        bits < 32 ? 0 : suffix * 2 + 1,
      ),
    ];
    return i;
  }
  if (estimate > target && entries.length > 1)
    throw Error("Exact hash collision exceeds packet budget; use a wider hash");
  const data = encodePairMembershipPacket(entries),
    leaf = {
      ...(await packetObjects.append(data)),
      namespace: ns,
      bits,
      prefix,
      suffix,
      bytes: data.length,
      crc32: crc32(data),
      pairs: entries.length,
    },
    id = leaves.length;
  leaves.push(leaf);
  report.packets++;
  report.packetBytes += data.length;
  report.maxPacketBytes = Math.max(report.maxPacketBytes, data.length);
  if (data.length > target) report.oversizedPackets++;
  return -id - 1;
}
function record(
  a: number,
  b: number,
  rows: PairColumnRow[],
  body: Uint32Array,
  title: Uint32Array,
  bodyOccurrences: number,
  titleOccurrences: number,
) {
  const bodyDocs = body,
    titleDocs = title;
  let i = 0,
    j = 0,
    df = 0;
  while (i < bodyDocs.length || j < titleDocs.length) {
    const d = Math.min(bodyDocs[i] ?? Infinity, titleDocs[j] ?? Infinity);
    if (bodyDocs[i] === d) i++;
    if (titleDocs[j] === d) j++;
    df++;
  }
  const base = {
    a,
    b,
    df,
    body: bodyDocs,
    title: titleDocs,
    bodyOccurrences,
    titleOccurrences,
  };
  let data = encodePairMembership(base, root.count),
    context: Uint8Array | undefined;
  report.membershipBytes += data.length;
  if (rows.length) {
    context = encodePairColumns(a, b, rows);
    if (data.length + context.length <= contextLimit) {
      data = encodePairMembership({ ...base, context }, root.count);
      report.contextPairs++;
      report.contextBytes += context.length;
    }
  }
  report.pairs++;
  report.documentMemberships += df;
  report.fieldMemberships += body.length + title.length;
  report.bodyOccurrences += bodyOccurrences;
  report.titleOccurrences += titleOccurrences;
  report.recordBytes += data.length;
  report.groupBytes[namespaceIds[a]] += data.length;
  report.dfHistogram[df]++;
  note(a, b, df, body.length, title.length, data.length);
  return {
    a: words[a],
    b: words[b],
    data,
    hash: route(a, b).hash,
    hash2: secondaryRoute(a, b),
  };
}
function records(data: Buffer): Entry[] {
  const { v, order } = orderRows(data),
    entries: Entry[] = [];
  for (let first = 0; first < order.length;) {
    const start = order[first] * 6,
      a = v[start],
      b = v[start + 1];
    let end = first + 1;
    while (
      end < order.length &&
      v[order[end] * 6] === a &&
      v[order[end] * 6 + 1] === b
    )
      end++;
    const body: number[] = [],
      title: number[] = [],
      rows: PairColumnRow[] = [],
      enrich = end - first <= contextLimit * 8;
    let last = -1,
      bodyOccurrences = 0,
      titleOccurrences = 0,
      current: PairColumnRow | undefined;
    for (let i = first; i < end; i++) {
      const at = order[i] * 6,
        df = v[at + 2],
        doc = df >>> 1,
        field = df & 1;
      if (df !== last) {
        (field ? title : body).push(doc);
        last = df;
      }
      if (field) titleOccurrences++;
      else bodyOccurrences++;
      if (enrich && rows.length <= contextLimit / 24) {
        if (!current || current.doc !== doc) {
          current = {
            doc,
            body: { positions: [], previous: [], next: [] },
            title: { positions: [], previous: [], next: [] },
          };
          rows.push(current);
        }
        const c = field ? current.title : current.body;
        (c.positions as number[]).push(v[at + 3]);
        (c.previous as number[]).push(v[at + 4]);
        (c.next as number[]).push(v[at + 5]);
      }
    }
    entries.push(
      record(
        a,
        b,
        rows.length > contextLimit / 24 ? [] : rows,
        Uint32Array.from(body),
        Uint32Array.from(title),
        bodyOccurrences,
        titleOccurrences,
      ),
    );
    first = end;
  }
  return entries;
}
// Raw partitions are recursively split before sorting. A single huge pair can
// be reduced in source order without loading its occurrence stream into memory.
async function homogeneous(path: string, a: number, b: number): Promise<Entry> {
  const file = await open(path, "r"),
    buffer = Buffer.allocUnsafe(24 * 65536),
    body: number[] = [],
    title: number[] = [];
  let last = -1,
    bn = 0,
    tn = 0;
  try {
    for (;;) {
      const { bytesRead: n } = await file.read(buffer, 0, buffer.length, null);
      if (!n) break;
      if (n % 24) throw Error("Truncated pair run");
      for (let at = 0; at < n; at += 24) {
        if (buffer.readUInt32LE(at) !== a || buffer.readUInt32LE(at + 4) !== b)
          throw Error("Mixed homogeneous pair");
        const df = buffer.readUInt32LE(at + 8),
          field = df & 1;
        if (df !== last) (field ? title : body).push(df >>> 1);
        last = df;
        if (field) tn++;
        else bn++;
      }
    }
  } finally {
    await file.close();
  }
  return record(
    a,
    b,
    [],
    Uint32Array.from(body),
    Uint32Array.from(title),
    bn,
    tn,
  );
}
async function packRun(
  path: string,
  ns: number,
  bits: number,
  prefix: number,
  known?: [number, number],
  suffix = 0,
): Promise<number> {
  const size = (await stat(path)).size;
  if (known && size > 48 * 1048576)
    return packetize(
      [await homogeneous(path, ...known)],
      ns,
      bits,
      prefix,
      suffix,
    );
  if (size <= 48 * 1048576)
    return packetize(records(await readFile(path)), ns, bits, prefix, suffix);
  if (bits === 64) throw Error("Oversized unresolved pair collision");
  const file = await open(path, "r"),
    buffer = Buffer.allocUnsafe(24 * 65536),
    paths = [path + "-0", path + "-1"],
    firsts: ([number, number] | undefined)[] = [],
    mixed = [false, false],
    counts = [0, 0];
  try {
    for (;;) {
      const { bytesRead: n } = await file.read(buffer, 0, buffer.length, null);
      if (!n) break;
      if (n % 24) throw Error("Truncated pair partition");
      const parts = [Buffer.allocUnsafe(n), Buffer.allocUnsafe(n)],
        lengths = [0, 0];
      for (let at = 0; at < n; at += 24) {
        const a = buffer.readUInt32LE(at),
          b = buffer.readUInt32LE(at + 4),
          bit =
            ((bits < 32 ? route(a, b).hash : secondaryRoute(a, b)) >>>
              (bits < 32 ? 31 - bits : 63 - bits)) &
            1;
        if (!firsts[bit]) firsts[bit] = [a, b];
        else if (firsts[bit]![0] !== a || firsts[bit]![1] !== b)
          mixed[bit] = true;
        buffer.copy(parts[bit], lengths[bit], at, at + 24);
        lengths[bit] += 24;
        counts[bit]++;
      }
      await Promise.all(
        parts.map((p, i) =>
          lengths[i]
            ? appendFile(paths[i], p.subarray(0, lengths[i]))
            : undefined,
        ),
      );
    }
  } finally {
    await file.close();
  }
  const id = nodes.length;
  nodes.push([NO_PAIR_PARTITION, NO_PAIR_PARTITION]);
  for (let bit = 0; bit < 2; bit++)
    if (counts[bit]) {
      nodes[id][bit] = await packRun(
        paths[bit],
        ns,
        bits + 1,
        bits < 32 ? prefix * 2 + bit : prefix,
        mixed[bit] ? undefined : firsts[bit],
        bits < 32 ? 0 : suffix * 2 + bit,
      );
      await rm(paths[bit]);
    }
  return id;
}
// Repacking reuses the complete occurrence materialization. N/M never enter
// this construction specification or these immutable objects.
for (const name of await readdir(out + "/scratch"))
  if (/\.bin-/.test(name))
    await rm(join(out, "scratch", name), { force: true });
for (let ns = 0; ns <= namespaces.length; ns++) {
  const bits = ns ? 2 : 8;
  async function descend(depth: number, prefix: number): Promise<number> {
    if (depth === bits) {
      const path = `${out}/scratch/${ns}-${bits}-${prefix}.bin`;
      const key = `${ns}-${bits}-${prefix}`;
      if (doneBuckets.has(key)) return doneBuckets.get(key)!;
      try {
        await stat(path);
      } catch (e: any) {
        if (e.code === "ENOENT") return NO_PAIR_PARTITION;
        throw e;
      }
      const id = await packRun(path, ns, bits, prefix);
      doneBuckets.set(key, id);
      await checkpoint();
      console.log(
        "Packed bucket",
        basename(path),
        "pairs",
        report.pairs,
        "bytes",
        report.packetBytes,
      );
      return id;
    }
    const id = nodes.length;
    nodes.push([NO_PAIR_PARTITION, NO_PAIR_PARTITION]);
    nodes[id] = [
      await descend(depth + 1, prefix * 2),
      await descend(depth + 1, prefix * 2 + 1),
    ];
    return id;
  }
  roots[ns] = await descend(0, 0);
}
const common = new Map(commonCommon);
for (const entry of top) common.set(`${entry.a}:${entry.b}`, entry);
const commonRanks = new Map(top.map((p, i) => [`${p.a}:${p.b}`, i]));
const commonPacket = encodePairMembershipPacket(
  [...common.values()].map((e) => ({
    a: words[e.a],
    b: words[e.b],
    data: new Uint8Array(
      Uint32Array.from([
        e.df,
        e.bodyDf,
        e.titleDf,
        e.bytes,
        (commonRanks.get(`${e.a}:${e.b}`) ?? -1) + 1,
      ]).buffer,
    ),
  })),
);
await packetObjects.flush();
const router = encodePairRouter(
  { ...specification, generation, roots },
  nodes,
  leaves,
  commonPacket,
);
report.routerBytes = router.length;
if (router.length > 8 * 1048576)
  throw Error(
    "Bundled pair router exceeds 8 MiB; increase packet size and repack",
  );
await writeFile(out + "/router.bin", router);
const presenceCounts = await readFile(out + "/presence-counts.bin"),
  pv = view(presenceCounts),
  presenceEntries = [];
await mkdir(out + "/presence", { recursive: true });
for (let rank = 0; rank < commonWords.length; rank++) {
  const read = async (field: number) => {
      try {
        const bytes = await readFile(
          `${out}/scratch/presence-${rank * 2 + field}.bin`,
        );
        return new Uint32Array(
          bytes.buffer,
          bytes.byteOffset,
          bytes.length / 4,
        );
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
        return new Uint32Array();
      }
    },
    word = commonWords[rank],
    body = await read(0),
    title = await read(1),
    data = encodePairMembership(
      {
        a: word.id,
        b: word.id,
        df: word.df,
        body,
        title,
        bodyOccurrences: pv.getFloat64(rank * 16, true),
        titleOccurrences: pv.getFloat64(rank * 16 + 8, true),
      },
      root.count,
    );
  await writeFile(`${out}/presence/${rank}.bin`, data);
  presenceEntries.push({
    ...word,
    bytes: data.length,
    crc32: crc32(data),
    bodyOccurrences: pv.getFloat64(rank * 16, true),
    titleOccurrences: pv.getFloat64(rank * 16 + 8, true),
  });
}
await writeFile(
  out + "/presence.json",
  JSON.stringify(
    {
      generation,
      encoding: "sorted blocked document-ID lists",
      bytes: presenceEntries.reduce((n, e) => n + e.bytes, 0),
      entries: presenceEntries,
    },
    null,
    2,
  ),
);
await writeFile(
  out + "/common-pairs.json",
  JSON.stringify(top.map((e) => ({ ...e, a: words[e.a], b: words[e.b] }))),
);
const exclusions = [500, 1000, 2000].map((m) => ({
  M: m,
  retainedGroupBytes: [...report.groupBytes].map(
    (bytes, ns) =>
      bytes -
      top
        .slice(0, m)
        .filter((p) => namespaceIds[p.a] === ns)
        .reduce((s, p) => s + p.bytes, 0),
  ),
}));
await writeFile(
  out + "/statistics.json",
  JSON.stringify(
    {
      ...report,
      groupBytes: [...report.groupBytes],
      dfHistogram: [...report.dfHistogram].flatMap((pairs, df) =>
        pairs ? [[df, pairs]] : [],
      ),
      contextFraction: report.contextPairs / report.pairs,
      commonPairs: top.length,
      commonCommonPairs: commonCommon.size,
      exclusions,
      elapsedMs: performance.now() - started,
      finishedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log("Complete pair index", {
  pairs: report.pairs,
  documentMemberships: report.documentMemberships,
  occurrences: report.bodyOccurrences + report.titleOccurrences,
  packetBytes: report.packetBytes,
  routerBytes: router.length,
  contextFraction: report.contextPairs / report.pairs,
});
