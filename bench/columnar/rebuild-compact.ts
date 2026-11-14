import { PacketObjects } from "../../src/columnar/packet-objects.js";
// Offline migration/measurement utility. Legacy readers are loaded solely from
// an explicitly frozen checkout; no legacy serving decoder is retained.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, createReadStream } from "node:fs";
import { createGunzip, gunzipSync, gzipSync } from "node:zlib";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  concat,
  pack,
  unpack,
  u32,
  view,
  encodeScores,
  encodeBranches,
  type Root,
  type Ref,
  type Branch,
} from "../../src/columnar/format.js";
import { encodePositions } from "../../src/columnar/positions.js";
import {
  encodeTermPacket,
  type PacketBlock,
} from "../../src/columnar/term-packet.js";
import { encodeTextChunks } from "../../src/columnar/text-chunks.js";
import { scanText } from "../../src/columnar/construction/text.js";
import {
  encodeDocumentDirectory,
  DocumentDirectory,
  type DocumentGroup,
} from "../../src/columnar/document-directory.js";
import {
  assembleTieredDirectory,
  assembleTermDirectory,
  encodeDirectoryBlock,
  type DirectoryTerm,
  type DirectoryBlock,
} from "../../src/columnar/term-directory.js";
import { encodeTermShard } from "../../src/columnar/term-shard.js";
import {
  PairPacket,
  encodePairColumns,
} from "../../src/columnar/pair-packet.js";
import {
  PairMembership,
  encodePairMembership,
  encodePairMembershipPacket,
} from "../../src/columnar/pair-membership.js";
import {
  PairRouter,
  encodePairRouter,
  pairObjectKey,
  type PairLeaf,
} from "../../src/columnar/pair-router.js";
import { Packer } from "../../src/columnar/packer.js";

const [input, store, pairs, corpus, output, control, stage] =
  process.argv.slice(2);
if (
  !stage ||
  !["lengths", "documents", "terms", "pairs", "finish"].includes(stage)
)
  throw Error(
    "Usage: yarn tsx bench/columnar/rebuild-compact.ts INDEX LOCAL_DATA PAIRS CORPUS.jsonl.gz OUTPUT FROZEN_CHECKOUT lengths|documents|terms|pairs|finish",
  );
if (
  [input, store, pairs, control].some(
    (p) =>
      resolve(output) === resolve(p) ||
      resolve(output).startsWith(resolve(p) + "/"),
  )
)
  throw Error("Output must be separate from control inputs");
const old: Root = JSON.parse(await readFile(input + "/root.json", "utf8")),
  started = performance.now();
await mkdir(output + "/packs", { recursive: true });
await mkdir(output + "/objects", { recursive: true });
const load = async (name: string) =>
  import(
    pathToFileURL(resolve(control + "/src/columnar/" + name + ".ts")).href
  );
const legacy = await load("format"),
  { TermDirectory: OldDirectory } = await load("term-directory"),
  { Reader: OldReader } = await load("storage");
const sha = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");
const report: any = {
  stage,
  sourceGeneration: old.generation,
  documents: old.count,
};
const saveReport = async () => {
  report.seconds = (performance.now() - started) / 1000;
  await writeFile(
    output + "/" + stage + "-report.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
};
const oldDocs = new DocumentDirectory(await readFile(input + "/documents.bin"));
const physical = (key: string) => store + "/objects/" + key;
const packageSource = (key: string) => readFile(physical(key));
let groupKey = "",
  groupData: Uint8Array;
async function oldPackage(doc: number) {
  const locator = oldDocs.lookup(doc);
  if (locator.key !== groupKey) {
    groupData = await packageSource(locator.key);
    groupKey = locator.key;
  }
  return groupData.subarray(locator.offset, locator.offset + locator.length);
}
const lengthsPath = output + "/lengths.bin";
if (stage === "lengths") {
  const lengths = new Uint32Array(old.count * 2);
  for (let doc = 0; doc < old.count; doc++) {
    const raw = await oldPackage(doc),
      v = view(raw);
    if (v.getUint32(0, true) !== 0x32504443 || v.getUint32(4, true) !== doc)
      throw Error("Control document identity mismatch");
    lengths[doc * 2] = v.getUint32(8, true);
    lengths[doc * 2 + 1] = v.getUint32(12, true);
  }
  await writeFile(lengthsPath, new Uint8Array(lengths.buffer));
  report.bytes = lengths.byteLength;
  await saveReport();
}
if (stage === "documents") {
  const raw = createReadStream(corpus),
    z = raw.pipe(createGunzip()),
    lines = createInterface({ input: z, crlfDelay: Infinity }),
    groups: DocumentGroup[] = [],
    packets: Uint8Array[] = [],
    offsets = [0];
  let first = 0,
    doc = 0,
    bytes = 0;
  const flush = async () => {
    if (!packets.length) return;
    const data = concat(packets),
      hash = sha(data),
      key = hash + "/plan-0.bin";
    await mkdir(output + "/objects/" + hash, { recursive: true });
    await writeFile(output + "/objects/" + key, data);
    groups.push({
      first,
      end: doc,
      sha256: hash,
      offsets: pack(offsets, true),
    });
    packets.length = 0;
    offsets.length = 1;
    offsets[0] = 0;
    first = doc;
  };
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (doc === old.count) break;
      const value = JSON.parse(line),
        source = await oldPackage(doc),
        v = view(source),
        section = (i: number) =>
          source.subarray(
            v.getUint32(16 + i * 8, true),
            v.getUint32(16 + i * 8, true) + v.getUint32(20 + i * 8, true),
          ),
        display = JSON.parse(gunzipSync(section(3)).toString()),
        scanned = scanText(value.body),
        starts = Array.from(scanned.tokens(), (t) => t.start);
      if (value.id !== display.id || starts.length !== v.getUint32(8, true))
        throw Error("Corpus/document mismatch at " + doc);
      const text = await encodeTextChunks(scanned.text, starts, (data) =>
          gzipSync(data),
        ),
        sections = [
          section(0),
          section(1),
          section(2),
          section(3),
          text.directory,
          text.data,
        ],
        header = source.slice(0, 64),
        h = view(header);
      h.setUint32(0, 0x33504443, true);
      let at = 64;
      sections.forEach((s, i) => {
        h.setUint32(16 + i * 8, at, true);
        h.setUint32(20 + i * 8, s.length, true);
        at += s.length;
      });
      const packet = concat([header, ...sections]);
      packets.push(packet);
      offsets.push(offsets.at(-1)! + packet.length);
      bytes += packet.length;
      doc++;
      if (packets.length === 128) await flush();
      if (doc % 25000 === 0)
        console.log(
          "documents",
          doc,
          bytes,
          Math.round((performance.now() - started) / 1000),
        );
    }
  } finally {
    lines.close();
    z.destroy();
    raw.destroy();
  }
  await flush();
  if (doc !== old.count) throw Error("Incomplete corpus");
  const directory = encodeDocumentDirectory(groups, doc);
  await writeFile(output + "/documents.bin", directory);
  report.bytes = bytes;
  report.groups = groups.length;
  await saveReport();
}
if (stage === "terms") {
  const lenRaw = await readFile(lengthsPath),
    lengths = new Uint32Array(
      lenRaw.buffer,
      lenRaw.byteOffset,
      lenRaw.byteLength / 4,
    ),
    objects = new Map(
      old.objects.map((o) => [o.key ?? `${old.generation}/${o.name}`, o]),
    ),
    cache = new Map<string, Uint8Array>();
  let retained = 0;
  const source = {
    async read(key: string, offset: number, length: number) {
      let raw = cache.get(key);
      if (raw) {
        cache.delete(key);
        cache.set(key, raw);
      } else {
        raw = readFileSync(physical(key));
        cache.set(key, raw);
        retained += raw.length;
        while (retained > 64 * 1048576 && cache.size > 1) {
          const first = cache.keys().next().value!;
          retained -= cache.get(first)!.length;
          cache.delete(first);
        }
      }
      if (!objects.has(key) || offset + length > raw.length)
        throw Error("Invalid source range");
      return raw.subarray(offset, offset + length);
    },
  };
  const reader = new OldReader(old, source),
    directory = new OldDirectory(
      await readFile(input + "/directory.bin"),
      old.count,
    ),
    db = new DatabaseSync(output + "/directory.sqlite");
  db.exec(
    "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-32768; DROP TABLE IF EXISTS terms; CREATE TABLE terms(word TEXT PRIMARY KEY,hot INTEGER,data TEXT) WITHOUT ROWID;",
  );
  const insert = db.prepare("INSERT INTO terms VALUES(?,?,?)"),
    storeOut = { next: 0, objects: [] as Root["objects"] },
    frequencies = new Packer(output + "/packs", storeOut),
    positions = new Packer(output + "/packs", storeOut),
    plans = new Packer(output + "/packs", storeOut);
  let n = 0,
    rows = 0,
    scoreBytes = 0,
    posBytes = 0;
  const read = (ref: Ref) => reader.read(ref);
  for await (const [word, term] of directory.allEntries(reader)) {
    const blocks: PacketBlock[] = [],
      posRefs: Ref[] = [],
      parts: Ref[] = [],
      positionParts: Ref[] = [],
      leaves: Branch[] = [];
    let pendingBytes = 24;
    const appendPosition = (ref: Ref) => {
      const last = positionParts.at(-1);
      if (last && last[0] === ref[0] && last[1] + last[2] <= ref[1])
        last[2] = ref[1] + ref[2] - last[1];
      else positionParts.push([...ref]);
    };
    const flush = () => {
      if (!blocks.length) return;
      const packet = encodeTermPacket(term.id, blocks, posRefs),
        ref = frequencies.put(packet.frequencies),
        v = view(packet.frequencies);
      parts.push(ref);
      for (let i = 0; i < blocks.length; i++) {
        const at = 24 + i * 48;
        leaves.push({
          ...blocks[i].branch,
          score: [
            ref[0],
            ref[1] + v.getUint32(at + 12, true),
            v.getUint32(at + 16, true),
          ],
          positions: posRefs[i],
          locators: [0, 0, 0],
        });
      }
      blocks.length = 0;
      posRefs.length = 0;
      pendingBytes = 24;
    };
    const add = async (score: Uint8Array, ref: Ref, b: number, t: number) => {
      const s = legacy.decodeScores(score),
        raw = await read(ref),
        v = view(raw),
        base = 4 + (s.docs.length + 1) * 4,
        postings = [];
      for (let row = 0; row < s.docs.length; row++) {
        const from = base + v.getUint32(4 + row * 4, true),
          end = base + v.getUint32(8 + row * 4, true),
          bn = v.getUint32(from, true);
        postings.push({
          body: legacy.unpack(raw.subarray(from + 4, from + 4 + bn)),
          title: legacy.unpack(raw.subarray(from + 4 + bn, end)),
        });
      }
      const pos = encodePositions(postings),
        encoded = encodeScores(
          Array.from(s.docs),
          Array.from(s.body),
          Array.from(s.title),
          Array.from(s.docs, (d: any) => lengths[d * 2]),
          Array.from(s.docs, (d: any) => lengths[d * 2 + 1]),
        ),
        p = positions.put(pos);
      if (blocks.length && pendingBytes + encoded.length + 48 > 4 * 1048576)
        flush();
      blocks.push({
        branch: {
          first: s.docs[0],
          last: s.docs.at(-1),
          count: s.docs.length,
          height: 0,
          b,
          t,
          score: [0, 0, 0],
          positions: p,
          locators: [0, 0, 0],
        },
        scores: encoded,
        positions: new Uint8Array(),
      });
      posRefs.push(p);
      appendPosition(p);
      pendingBytes += encoded.length + 48;
      rows += s.docs.length;
      scoreBytes += encoded.length;
      posBytes += pos.length;
    };
    for (const ref of [term.frequencies, ...(term.frequencyParts ?? [])]) {
      const data = await read(ref),
        v = view(data);
      if (v.getUint32(0, true) !== 0x33465443) {
        await add(data, term.positional, term.tree.b, term.tree.t);
        continue;
      }
      const count = v.getUint32(12, true),
        absolute = !!(v.getUint32(20, true) & 0x80000000);
      for (let i = 0; i < count; i++) {
        const p = 24 + i * 48,
          at = v.getUint32(p + 12, true),
          bytes = v.getUint32(p + 16, true),
          pr: Ref = [
            v.getUint32(p + 20, true),
            v.getUint32(p + 24, true),
            v.getUint32(p + 28, true),
          ];
        if (!absolute) {
          pr[0] = term.positional[0];
          pr[1] += term.positional[1];
        }
        await add(
          data.subarray(at, at + bytes),
          pr,
          v.getFloat64(p + 32, true),
          v.getFloat64(p + 40, true),
        );
      }
    }
    flush();
    let nodes = leaves;
    while (nodes.length > 1) {
      const parents: Branch[] = [];
      for (let i = 0; i < nodes.length; i += 64) {
        const list = nodes.slice(i, i + 64);
        parents.push({
          first: list[0].first,
          last: list.at(-1)!.last,
          count: list.reduce((n, b) => n + b.count, 0),
          height: list[0].height + 1,
          b: Math.max(...list.map((b) => b.b)),
          t: Math.max(...list.map((b) => b.t)),
          score: plans.put(encodeBranches(list)),
          positions: [0, 0, 0],
          locators: [0, 0, 0],
        });
      }
      nodes = parents;
    }
    const next: DirectoryTerm = {
      id: term.id,
      df: term.df,
      bodyOccurrences: term.bodyOccurrences,
      titleOccurrences: term.titleOccurrences,
      tree: nodes[0],
      frequencies: parts[0],
      positional: positionParts[0],
      ...(parts.length > 1 ? { frequencyParts: parts.slice(1) } : {}),
      ...(positionParts.length > 1
        ? { positionalParts: positionParts.slice(1) }
        : {}),
    };
    insert.run(word, n < 1000000 ? 1 : 0, JSON.stringify(next));
    if (++n % 100000 === 0)
      console.log(
        "terms",
        n,
        "postings",
        rows,
        Math.round((performance.now() - started) / 1000),
      );
  }
  frequencies.flush();
  positions.flush();
  plans.flush();
  const hot: DirectoryBlock[] = [],
    cold: DirectoryBlock[] = [];
  let pending: [string, DirectoryTerm][] = [],
    inline: { ref: Ref; data: Uint8Array }[] = [],
    pendingBytes = 0;
  const newCache = new Map<number, Uint8Array>();
  const readNew = (ref: Ref) => {
    const object = storeOut.objects[ref[0]],
      raw =
        newCache.get(ref[0]) ?? readFileSync(output + "/packs/" + object.name);
    if (!newCache.has(ref[0])) {
      newCache.set(ref[0], raw);
      if (newCache.size > 4) newCache.delete(newCache.keys().next().value!);
    }
    return raw.subarray(ref[1], ref[1] + ref[2]);
  };
  const coldWriter = new Packer(output + "/packs", storeOut);
  for (const isHot of [1, 0]) {
    const flush = () => {
      if (!pending.length) return;
      const metadata = gzipSync(encodeDirectoryBlock(pending)),
        first = pending[0][0],
        count = pending.length;
      if (isHot) hot.push({ first, count, data: metadata });
      else {
        const packet = encodeTermShard(metadata, inline),
          ref = coldWriter.put(packet);
        cold.push({ first, count, data: u32(ref) });
      }
      pending = [];
      inline = [];
      pendingBytes = 0;
    };
    for (const row of db
      .prepare(
        "SELECT word,data FROM terms WHERE hot=? ORDER BY word COLLATE BINARY",
      )
      .iterate(isHot) as Iterable<any>) {
      const term: DirectoryTerm = JSON.parse(row.data),
        small =
          !isHot &&
          !term.tree.height &&
          !term.frequencyParts &&
          !term.positionalParts &&
          term.frequencies[2] + term.positional[2] <= 4096;
      if (
        pending.length &&
        (pending.length >= 128 ||
          pendingBytes +
            (small ? term.frequencies[2] + term.positional[2] : 128) >
            128 * 1024)
      )
        flush();
      pending.push([row.word, term]);
      pendingBytes += 128;
      if (small)
        for (const ref of [term.frequencies, term.positional]) {
          const data = readNew(ref);
          inline.push({ ref, data });
          pendingBytes += data.length;
        }
    }
    flush();
  }
  coldWriter.flush();
  db.close();
  const binary = assembleTieredDirectory(
    assembleTermDirectory(hot),
    assembleTermDirectory(cold),
  );
  await writeFile(output + "/directory.bin", binary);
  await writeFile(
    output + "/term-objects.json",
    JSON.stringify(storeOut.objects),
  );
  report.terms = n;
  report.postings = rows;
  report.scoreBytes = scoreBytes;
  report.positionBytes = posBytes;
  report.bytes = storeOut.objects.reduce((n, o) => n + o.size, 0);
  await saveReport();
}
if (stage === "pairs") {
  const { PairRouter: OldRouter, pairObjectKey: oldPairObjectKey } =
      await load("pair-router"),
    { PairMembership: OldMembership } = await load("pair-membership"),
    { PairPacket: OldPair } = await load("pair-packet"),
    router = new OldRouter(await readFile(pairs + "/router.bin")),
    raw = router.bytes,
    v = view(raw),
    j = v.getUint32(4, true),
    n = v.getUint32(8, true),
    l = v.getUint32(12, true),
    start = 20 + j,
    table = start + n * 8,
    nodes: [number, number][] = Array.from({ length: n }, (_, i) => [
      v.getInt32(start + i * 8, true),
      v.getInt32(start + i * 8 + 4, true),
    ]),
    leaves: PairLeaf[] = [],
    generation = sha("compact-pairs-4:" + router.metadata.generation);
  let memberships = 0,
    contexts = 0,
    bytes = 0;
  const commonStart = table + l * 28,
    commonRaw = raw.subarray(commonStart),
    cv = view(commonRaw),
    commonEntries = [];
  for (let i = 0; i < cv.getUint32(4, true); i++) {
    const k = cv.getUint32(16 + i * 16, true),
      kn = cv.getUint32(20 + i * 16, true),
      key = new TextDecoder().decode(commonRaw.subarray(k, k + kn)).split("\0"),
      at = cv.getUint32(24 + i * 16, true),
      len = cv.getUint32(28 + i * 16, true);
    commonEntries.push({
      a: key[0],
      b: key[1],
      data: commonRaw.subarray(at, at + len),
    });
  }
  const packetObjects = new PacketObjects(async (id, data) => {
    await writeFile(output + "/objects/pairs-" + id + ".bin", data);
  });
  for (let i = 0; i < l; i++) {
    const p = table + i * 28,
      leaf = {
        object: 0,
        offset: 0,
        namespace: v.getUint32(p, true),
        bits: v.getUint32(p + 4, true),
        prefix: v.getUint32(p + 8, true),
        bytes: 0,
        crc32: 0,
        pairs: v.getUint32(p + 20, true),
        suffix: v.getUint32(p + 24, true),
      },
      name = oldPairObjectKey(router.metadata.generation, leaf).split("/")[1],
      data = await readFile(pairs + "/objects/" + name),
      dv = view(data),
      entries = [];
    for (let row = 0; row < dv.getUint32(4, true); row++) {
      const p = 16 + row * 16,
        k = dv.getUint32(p, true),
        kn = dv.getUint32(p + 4, true),
        key = new TextDecoder().decode(data.subarray(k, k + kn)).split("\0"),
        at = dv.getUint32(p + 8, true),
        len = dv.getUint32(p + 12, true),
        record = new OldMembership(data.subarray(at, at + len), old.count),
        body = Uint32Array.from(record.body.values()),
        title = Uint32Array.from(record.title.values());
      let context: Uint8Array | undefined;
      if (record.context) {
        const packet = record.context;
        context = encodePairColumns(
          record.a,
          record.b,
          Array.from(packet.docs, (doc: any, row: number) => ({
            doc,
            body: packet.occurrences(row, 0),
            title: packet.occurrences(row, 1),
          })),
        );
        contexts++;
      }
      const encoded = encodePairMembership(
        { ...record, body, title, context },
        old.count,
      );
      entries.push({ a: key[0], b: key[1], data: encoded });
      memberships += record.df;
    }
    const encoded = encodePairMembershipPacket(entries);
    leaf.bytes = encoded.length;
    leaves.push(leaf);
    Object.assign(leaf, await packetObjects.append(encoded));
    bytes += encoded.length;
    if ((i + 1) % 10000 === 0)
      console.log(
        "pairs",
        i + 1,
        "/",
        l,
        bytes,
        Math.round((performance.now() - started) / 1000),
      );
  }
  await packetObjects.flush();
  const encoded = encodePairRouter(
    { ...router.metadata, generation },
    nodes,
    leaves,
    encodePairMembershipPacket(commonEntries),
  );
  await writeFile(output + "/router.bin", encoded);
  report.bytes = bytes;
  report.packets = l;
  report.memberships = memberships;
  report.contexts = contexts;
  await saveReport();
}
if (stage === "finish") {
  const objects: Root["objects"] = JSON.parse(
      await readFile(output + "/term-objects.json", "utf8"),
    ),
    documents = await readFile(output + "/documents.bin"),
    directory = await readFile(output + "/directory.bin"),
    docReport = JSON.parse(
      await readFile(output + "/documents-report.json", "utf8"),
    );
  const root: Root = {
    ...old,
    generation: "",
    documents: [],
    dictionaries: [],
    dictionaryHeight: 0,
    hot: {},
    objects,
    objectIds: undefined,
    directory: {
      sha256: sha(directory),
      bytes: directory.length,
      terms: old.directory!.terms,
    },
    documentPackages: {
      generation: sha(
        "compact-documents-3:" + old.documentPackages!.generation,
      ),
      count: old.count,
      bytes: docReport.bytes,
      averageBytes: docReport.bytes / old.count,
      locators: {
        sha256: sha(documents),
        bytes: documents.length,
        groups: docReport.groups,
      },
    },
  };
  root.generation = sha(JSON.stringify(root));
  for (const object of objects) {
    const hash = object.sha256;
    await mkdir(output + "/objects/" + hash, { recursive: true });
    const { link } = await import("node:fs/promises");
    await link(
      output + "/packs/" + object.name,
      output + "/objects/" + hash + "/plan-0.bin",
    ).catch((e: any) => {
      if (e.code !== "EEXIST") throw e;
    });
    object.key = hash + "/plan-0.bin";
  }
  root.generation = sha(JSON.stringify({ ...root, generation: undefined }));
  await writeFile(output + "/root.json", JSON.stringify(root));
  report.generation = root.generation;
  report.bytes = objects.reduce((n, o) => n + o.size, 0) + docReport.bytes;
  await saveReport();
}
