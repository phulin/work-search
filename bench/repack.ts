// Offline benchmark utility: re-embed already-built immutable v5 streams without
// rebuilding/tokenizing the same corpus. Each output has a distinct generation.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BinaryIndex, buildBinary, LOCAL } from "../src/format/index.js";
import { selectPostings, selectStreams } from "../src/builder/selection.js";
export async function repack(
  source: string,
  out: string,
  budget: number,
  policy: "frequency" | "mixed",
  workload: string[],
) {
  const started = performance.now(),
    bytes = await readFile(join(source, "bundle.bin")),
    index = new BinaryIndex(bytes);
  const sourceManifest = JSON.parse(
    await readFile(join(source, "manifest.json"), "utf8"),
  );
  if (
    createHash("sha256").update(bytes).digest("hex") !==
    sourceManifest.bundleSha256
  )
    throw new Error("Source bundle hash mismatch");
  const entries = Array.from({ length: index.termCount }, (_, i) =>
    index.entry(i),
  );
  if (index.local > budget) throw new Error("Mandatory sections exceed budget");
  const joint =
    policy === "mixed"
      ? selectStreams(entries, budget - index.local, workload)
      : undefined;
  const chosen =
    joint?.frequencies ??
    selectPostings(entries, budget - index.local, "workload", workload);
  const fbytes = entries.reduce(
    (s, e) => s + (chosen.has(e.term) ? e.length : 0),
    0,
  );
  const pos =
    joint?.positions ??
    selectPostings(
      entries
        .filter((e) => chosen.has(e.term))
        .map((e) => ({ term: e.term, length: e.positionLength })),
      budget - index.local - fbytes,
      "workload",
      workload,
    );
  const generation = createHash("sha256")
    .update(
      JSON.stringify({
        repack: 1,
        source: index.generation,
        budget,
        policy,
        workload,
      }),
    )
    .digest("hex");
  const root = join(out, "objects", generation);
  await mkdir(root, { recursive: true });
  const sourceObjects = new Map<string, Uint8Array>();
  async function stream(e: (typeof entries)[number], positions: boolean) {
    const object = positions ? e.positionObject : e.object,
      offset = positions ? e.positionOffset : e.offset,
      length = positions ? e.positionLength : e.length;
    if (object === LOCAL)
      return index.bytes.subarray(
        index.local + offset,
        index.local + offset + length,
      );
    const key = index.key(object, positions ? "positions" : "frequencies");
    let data = sourceObjects.get(key);
    if (!data) {
      data = await readFile(join(source, "objects", key));
      const expected = sourceManifest.objects.find((o: any) => o.key === key);
      if (
        !expected ||
        data.length !== expected.size ||
        createHash("sha256").update(data).digest("hex") !== expected.sha256
      )
        throw new Error("Source object hash mismatch");
      sourceObjects.set(key, data);
    }
    return data.subarray(offset, offset + length);
  }
  const payloads: { f: Uint8Array; p: Uint8Array }[] = [];
  for (const e of entries)
    payloads.push({ f: await stream(e, false), p: await stream(e, true) });
  const embedded: Uint8Array[] = [],
    objects: { key: string; size: number; sha256: string; kind: string }[] = [];
  let local = 0;
  for (const [kind, set, property] of [
    ["frequencies", chosen, "f"],
    ["positions", pos, "p"],
  ] as const) {
    let number = 0,
      offset = 0,
      path = join(root, `${kind}-0.bin`),
      output = createWriteStream(path);
    async function close() {
      output.end();
      await once(output, "finish");
      const data = await readFile(path);
      objects.push({
        key: `${generation}/${kind}-${number}.bin`,
        size: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        kind,
      });
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i],
        data = payloads[i][property];
      let object: number, start: number;
      if (set.has(e.term)) {
        object = LOCAL;
        start = local;
        local += data.length;
        embedded.push(data);
      } else {
        if (offset && offset + data.length > 64 * 1024 * 1024) {
          await close();
          number++;
          offset = 0;
          path = join(root, `${kind}-${number}.bin`);
          output = createWriteStream(path);
        }
        object = number;
        start = offset;
        offset += data.length;
        if (!output.write(data)) await once(output, "drain");
      }
      if (kind === "positions") {
        e.positionObject = object;
        e.positionOffset = start;
      } else {
        e.object = object;
        e.offset = start;
      }
    }
    await close();
  }

  for (const object of sourceManifest.objects.filter(
    (o: any) => o.kind === "metadata",
  )) {
    const data = await readFile(join(source, "objects", object.key)),
      name = object.key.split("/").pop()!,
      key = `${generation}/${name}`;
    if (createHash("sha256").update(data).digest("hex") !== object.sha256)
      throw new Error("Source metadata hash mismatch");
    await writeFile(join(root, name), data);
    objects.push({ ...object, key });
  }
  const binary = buildBinary(
    generation,
    entries,
    index.bytes.subarray(index.docs, index.local),
    index.count,
    embedded,
    index.avgBody,
    index.avgTitle,
  );
  if (binary.length > budget) throw new Error("Budget overflow");
  await writeFile(join(out, "bundle.bin"), binary);
  const manifest = {
    ...sourceManifest,
    generation,
    budget,
    strategy: policy === "mixed" ? "mixed" : "workload",
    embeddingPolicy: policy === "mixed" ? "joint-streams" : "frequencies-first",
    bundleBytes: binary.length,
    bundleSha256: createHash("sha256").update(binary).digest("hex"),
    embeddedFrequencyBytes: fbytes,
    embeddedPositionBytes: local - fbytes,
    embeddedBytes: local,
    embeddedTerms: chosen.size,
    embeddedPositionTerms: pos.size,
    objects,
  };
  await writeFile(
    join(out, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return {
    source: index.generation,
    generation,
    budget,
    policy,
    buildKind: "Repacked existing encoded streams; not corpus build throughput",
    ms: performance.now() - started,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    bundleBytes: binary.length,
  };
}
if (process.argv[1]?.endsWith("/repack.ts")) {
  const [source, out, budget, policy, file] = process.argv.slice(2);
  console.log(
    JSON.stringify(
      await repack(
        source,
        out,
        Number(budget),
        policy as "frequency" | "mixed",
        (await readFile(file, "utf8")).split("\n").filter(Boolean),
      ),
    ),
  );
}
