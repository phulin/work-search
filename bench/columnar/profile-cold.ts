import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Session } from "node:inspector";
import { gzipSync, gunzipSync } from "node:zlib";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  loadServingAssets,
  servingOptions,
} from "../../scripts/columnar-serving.js";
import { ColumnarIndex } from "../../src/columnar/search.js";
import { TermDirectory } from "../../src/columnar/term-directory.js";
import { DocumentDirectory } from "../../src/columnar/document-directory.js";
import { Memory, Reader, Lru } from "../../src/columnar/storage.js";
import { RangeStorage } from "./range-storage.js";
import { benchmarkToken } from "./token.js";

const [index, contractPath, output] = process.argv.slice(2);
if (!output) throw Error("Use INDEX QUERY_CONTRACT_GZ OUTPUT_DIRECTORY");
const assets = await loadServingAssets(index, servingOptions()),
  contract = JSON.parse(gunzipSync(await readFile(contractPath)).toString()),
  selected = process.env.CWS_QUERY_IDS?.split(",").map(Number),
  scenarios = contract.scenarios.filter(
    (_: any, i: number) => !selected || selected.includes(i),
  ),
  storage = new RangeStorage(assets.root, index + "/local-ranges", {
    url: "https://work-search-cws-upload.phulin.workers.dev",
    token: await benchmarkToken(),
  }),
  repeats = Number(process.env.CWS_REPEATS ?? 5);
const provenance = {
  startedAt: new Date().toISOString(),
  code: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  generation: assets.root.generation,
  corpusHash: assets.root.corpusHash,
  documents: assets.root.count,
  contractSha256: createHash("sha256")
    .update(await readFile(contractPath))
    .digest("hex"),
  node: process.version,
  exactTotal: false,
  sourceSha256: Object.fromEntries(
    await Promise.all(
      [
        "search",
        "document-directory",
        "membership-anchor",
        "pair-packet",
        "pair-positions",
        "exact-phrase",
        "storage",
      ].map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(`src/columnar/${name}.ts`))
          .digest("hex"),
      ]),
    ),
  ),
};
await mkdir(output, { recursive: true });
async function query(s: any) {
  const memory = new Memory();
  memory.pages = new Lru(12 * 1048576);
  memory.decoded = new Lru(4 * 1048576);
  const engine = new ColumnarIndex(
      assets.root,
      undefined,
      new TermDirectory(assets.directory!, assets.root.count),
      undefined,
      new DocumentDirectory(assets.documents!),
      assets.membership,
    ),
    reader = new Reader(assets.root, storage, memory),
    start = performance.now(),
    cpu = process.cpuUsage();
  const result = await engine.search(s.q, reader, {
    ...s.options,
    exactTotal: false,
    metadata: true,
    snippets: true,
  });
  const serialized = JSON.stringify(result),
    usage = process.cpuUsage(cpu);
  return {
    wallMs: performance.now() - start,
    cpuMs: (usage.user + usage.system) / 1000,
    bytes: Buffer.byteLength(serialized),
    diagnostics: result.diagnostics,
    results: result.results.map((h) => [h.doc, h.score]),
  };
}
storage.prepare = true;
for (const s of scenarios) {
  await query(s);
  console.log("Prepared", s.q);
}
storage.prepare = false;
const preparation = await storage.verify(),
  rows: any[] = [];
const session = new Session();
session.connect();
const post = promisify(session.post.bind(session)) as (
  method: string,
  params?: any,
) => Promise<any>;
try {
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: 500 });
  for (const [i, s] of scenarios.entries()) {
    await post("Profiler.start");
    const calls = [];
    for (let n = 0; n < repeats; n++) calls.push(await query(s));
    const { profile } = await post("Profiler.stop");
    await writeFile(
      output + `/${i}.cpuprofile.gz`,
      gzipSync(JSON.stringify(profile)),
    );
    const nodes = new Map(profile.nodes.map((n: any) => [n.id, n])),
      self = new Map<string, number>();
    for (let n = 0; n < (profile.samples?.length ?? 0); n++) {
      const f = (nodes.get(profile.samples[n]) as any).callFrame,
        key = `${f.functionName || "(anonymous)"} ${f.url}:${f.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + profile.timeDeltas[n]);
    }
    rows.push({
      q: s.q,
      calls,
      selfCpuMicros: Object.fromEntries([...self].sort((a, b) => b[1] - a[1])),
    });
    await writeFile(
      output + "/summary.json",
      JSON.stringify(
        {
          provenance,
          preparation,
          repeats,
          rows,
          note: "Local CPU attribution only; every call has empty application caches and no shared cache. Prepared filesystem reads have no simulated delay. Not native Worker CPU or latency.",
        },
        null,
        2,
      ),
    );
    console.log(
      "Profiled",
      s.q,
      calls.map((r) => Math.round(r.cpuMs)),
      [...self].sort((a, b) => b[1] - a[1]).slice(0, 8),
    );
  }
} finally {
  session.disconnect();
}
