/** Repack the complete ordinal vocabulary once. Bundle a bounded common subset;
 * route the remainder directly to small self-contained immutable R2 packets. */
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { benchmarkToken } from "../bench/columnar/token.js";
import {
  encodeWords,
  decodeWords,
  assembleWords,
  WordDirectory,
} from "../src/columnar/word-directory.js";
import { view, u32 } from "../src/columnar/format.js";
import type { DirectoryBlock } from "../src/columnar/term-directory.js";
import type { WordPacket } from "../src/columnar/construction/word-lookup.js";
const [buildDir, out, completeDir = out + "/complete"] = process.argv.slice(2);
if (!out)
  throw Error("Use BUILD_DIRECTORY OUTPUT_DIRECTORY [COMPLETE_WORD_DIRECTORY]");
await mkdir(out + "/packets", { recursive: true });
if (
  !(await stat(completeDir + "/manifest.json").then(
    () => true,
    () => false,
  ))
)
  await new Promise<void>((ok, no) => {
    const p = spawn(
      "yarn",
      [
        "node",
        "--import",
        "tsx",
        "scripts/build-construction-word-directory.ts",
        buildDir,
        completeDir,
      ],
      { stdio: "inherit" },
    );
    p.once("error", no);
    p.once("exit", (c) =>
      c === 0 ? ok() : no(Error("Complete vocabulary preparation " + c)),
    );
  });
const state = JSON.parse(await readFile(buildDir + "/build.json", "utf8")),
  root = JSON.parse(await readFile(buildDir + "/scoring-root.json", "utf8")),
  complete = JSON.parse(await readFile(completeDir + "/manifest.json", "utf8")),
  bytes = await readFile(completeDir + "/words-2048.bin"),
  v = view(bytes),
  digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex"),
  token = await benchmarkToken(),
  uploader = "https://work-search-cws-upload.phulin.workers.dev";
if (
  complete.sourceRoot.sha256 !== state.rootRef.sha256 ||
  complete.count !== state.terms ||
  digest(bytes) !==
    complete.variants.find((v: any) => v.blockSize === 2048).sha256
)
  throw Error("Complete construction vocabulary identity mismatch");
// Range presence is a cache-selection statistic, never a matching/ranking rule.
// Existing resumable outputs give representative observations without rereading
// source text or its old dictionary. Fresh builds bootstrap with native hot DFs.
const available = state.vocabularies.filter(
    (j: any) => j.next === j.end && j.segments?.length,
  ),
  sample = Array.from(
    { length: Math.min(64, available.length) },
    (_, i) =>
      available[
        Math.floor((i * available.length) / Math.min(64, available.length))
      ],
  ),
  counts = new Uint16Array(state.terms + 1);
let sampleReads = 0;
async function fetchBytes(ref: any) {
  for (let attempt = 0; ; attempt++)
    try {
      const r = await fetch(uploader + "/" + ref.key, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(120000),
      });
      if (!r.ok) throw Error("Construction vocabulary read " + r.status);
      const b = new Uint8Array(await r.arrayBuffer());
      if (b.length !== ref.size || digest(b) !== ref.sha256)
        throw Error("Construction vocabulary checksum mismatch");
      return b;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
}
for (const job of sample) {
  const seen = new Set<number>();
  for (const segment of job.segments) {
    const value = JSON.parse(
      gunzipSync(await fetchBytes(segment.ref)).toString(),
    );
    sampleReads++;
    if (value.generation !== root.generation)
      throw Error("Vocabulary sample generation mismatch");
    for (const [word, id] of value.ids) {
      if (
        typeof word !== "string" ||
        !Number.isInteger(id) ||
        id < 1 ||
        id > state.terms
      )
        throw Error("Invalid vocabulary sample ID");
      seen.add(id);
    }
  }
  for (const id of seen) counts[id]++;
}
for (const term of Object.values(root.hot) as any[])
  counts[term.id] = sample.length + 1;
const capacity = 1000000,
  histogram = new Uint32Array(sample.length + 2);
for (const n of counts) if (n) histogram[n]++;
let target = Math.min(
    capacity,
    histogram.reduce((n, x) => n + x, 0),
  ),
  cutoff = histogram.length - 1,
  above = 0;
while (cutoff > 0 && above + histogram[cutoff] < target) {
  above += histogram[cutoff];
  cutoff--;
}
const hotIds: number[] = [],
  hotBlocks: DirectoryBlock[] = [],
  hotPending: string[] = [],
  packets: WordPacket[] = [];
let ordinal = 1,
  packetFirst = 1,
  pending: DirectoryBlock[] = [],
  pendingBytes = 0,
  packetLast = "",
  ties = 0;
function hotFlush() {
  if (!hotPending.length) return;
  hotBlocks.push({
    first: hotPending[0],
    count: hotPending.length,
    data: encodeWords(hotPending),
  });
  hotPending.length = 0;
}
async function flush() {
  if (!pending.length) return;
  const data = assembleWords(pending),
    sha256 = digest(data),
    count = pending.reduce((n, b) => n + b.count, 0);
  if (data.length > 2 * 1048576)
    throw Error("Unbounded construction word packet");
  const ref = { key: sha256 + "/plan-0.bin", size: data.length, sha256 };
  await writeFile(out + "/packets/" + sha256 + ".bin", data);
  packets.push({
    first: pending[0].first,
    last: packetLast,
    firstId: packetFirst,
    count,
    ref,
  });
  packetFirst += count;
  pending = [];
  pendingBytes = 0;
}
for (let i = 0; i < v.getUint32(8, true); i++) {
  const p = 16 + i * 20,
    at = v.getUint32(p + 8, true),
    size = v.getUint32(p + 12, true),
    raw = bytes.subarray(at, at + size),
    words = decodeWords(raw);
  if (v.getUint32(p + 16, true) + 1 !== ordinal)
    throw Error("Construction word ordinal gap");
  if (
    pending.length &&
    pendingBytes + raw.length + words[0].length * 3 + 20 > 256 * 1024
  )
    await flush();
  pending.push({ first: words[0], count: words.length, data: raw });
  pendingBytes += raw.length + words[0].length * 3 + 20;
  packetLast = words.at(-1)!;
  for (const word of words) {
    const frequency = counts[ordinal];
    if (
      frequency > cutoff ||
      (frequency === cutoff && frequency > 0 && ties++ < target - above)
    ) {
      hotIds.push(ordinal);
      hotPending.push(word);
      if (hotPending.length === 2048) hotFlush();
    }
    ordinal++;
  }
}
await flush();
hotFlush();
if (ordinal - 1 !== state.terms || hotIds.length !== target)
  throw Error("Incomplete construction vocabulary");
const hot = assembleWords(hotBlocks),
  ids = u32(hotIds);
if (hot.length + ids.length > 16 * 1048576)
  throw Error(
    "Common construction vocabulary exceeds its 16 MiB bundle budget",
  );
await writeFile(out + "/hot.bin", hot);
await writeFile(out + "/ids.bin", ids);
const directory = new WordDirectory(hot);
if (directory.count !== hotIds.length)
  throw Error("Hot dictionary identity mismatch");
let next = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (;;) {
      const i = next++;
      if (i >= packets.length) return;
      const p = packets[i],
        data = await readFile(out + "/packets/" + p.ref.sha256 + ".bin");
      for (let retry = 0; ; retry++)
        try {
          const r = await fetch(uploader + "/" + p.ref.key, {
            method: "PUT",
            headers: {
              authorization: `Bearer ${token}`,
              "x-sha256": p.ref.sha256,
              "x-raw-length": String(data.length),
              "x-transport": "raw",
            },
            body: data,
            signal: AbortSignal.timeout(120000),
          });
          if (!r.ok)
            throw Error(
              "Construction word packet upload " +
                r.status +
                " " +
                (await r.text()),
            );
          break;
        } catch (e) {
          if (retry >= 4) throw e;
          await new Promise((r) => setTimeout(r, 500 * 2 ** retry));
        }
    }
  }),
);
const manifest = {
  generation: root.generation,
  count: state.count,
  rootSha256: state.rootRef.sha256,
  terms: state.terms,
  hotTerms: hotIds.length,
  hotBytes: hot.length,
  hotSha256: digest(hot),
  idsBytes: ids.length,
  idsSha256: digest(ids),
  packets,
  packetBytes: packets.reduce((n, p) => n + p.ref.size, 0),
  selection: {
    kind: "native hot document frequencies plus range-presence counts from evenly spaced completed corpus ranges",
    ranges: sample.length,
    reads: sampleReads,
    capacity,
  },
  preparedAt: new Date().toISOString(),
};
await writeFile(out + "/manifest.json", JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ ...manifest, packets: packets.length }, null, 2));
