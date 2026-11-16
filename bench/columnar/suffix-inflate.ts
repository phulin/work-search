import { Miniflare } from "miniflare";
import { open, readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import type {
  SuffixBlock,
  SuffixManifest,
  SuffixColumn,
} from "../../src/suffix/format.js";
import "../../scripts/workerd-runtime.js";

const [directory, output] = process.argv.slice(2);
if (!output) throw Error("Use SUFFIX_DIRECTORY OUTPUT_JSON");
const manifest: SuffixManifest = JSON.parse(
    await readFile(directory + "/manifest-numeric.json", "utf8"),
  ),
  handles = new Map<string, ReturnType<typeof open>>(),
  frames: { offset: number; length: number; output: number; check: number }[] =
    [],
  parts: Uint8Array[] = [];
let bytes = 0;
async function read(file: string, offset: number, length: number) {
  let pending = handles.get(file);
  if (!pending)
    handles.set(file, (pending = open(directory + "/" + file, "r")));
  const data = Buffer.allocUnsafe(length);
  if (
    (await (await pending).read(data, 0, length, offset)).bytesRead !== length
  )
    throw Error("Truncated suffix input");
  return data;
}
try {
  // Uniform physical coverage, independent of benchmark query strings.
  for (let i = 0; i < 16; i++) {
    const group =
        manifest.directory[Math.floor((i * manifest.directory.length) / 16)],
      blocks: SuffixBlock[] = JSON.parse(
        gunzipSync(
          await read("directory", group.ref.offset, group.ref.length),
        ).toString(),
      ),
      block = blocks[Math.floor(blocks.length / 2)];
    for (const column of [
      "documents",
      "positions",
      "flags",
      "keys",
    ] as SuffixColumn[]) {
      const ref = block.columns[column],
        raw = await read(column, ref.offset, ref.length),
        data = gunzipSync(raw);
      frames.push({
        offset: bytes,
        length: raw.length,
        output: data.length,
        check: data.length + (data[0] ?? 0) + (data.at(-1) ?? 0),
      });
      bytes += raw.length;
      parts.push(raw);
    }
  }
} finally {
  await Promise.all([...handles.values()].map(async (h) => (await h).close()));
}
const iterations = 384,
  moduleRoot = resolve("work/suffix-inflate-runtime"),
  source = `
import data from './frames.bin';
import {gunzipSync} from 'node:zlib';
const bytes=new Uint8Array(data),frames=${JSON.stringify(frames)};
export default {async fetch(request){
const method=new URL(request.url).searchParams.get('method'),start=performance.now();let check=0,expanded=0;
for(let i=0;i<${iterations};i++){
const f=frames[i%frames.length],raw=bytes.subarray(f.offset,f.offset+f.length);
const value=method==='streams'?new Uint8Array(await new Response(new Response(raw).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()):method==='native-copy'?new Uint8Array(gunzipSync(raw)):gunzipSync(raw);
if(value.length!==f.output)throw Error('Inflated length mismatch');
expanded+=value.length;check+=value.length+(value[0]??0)+(value.at(-1)??0);
}
return Response.json({method,reportedMs:performance.now()-start,check,expanded});
}};`,
  mf = new Miniflare({
    compatibilityDate: "2026-11-01",
    modulesRoot: moduleRoot,
    modules: [
      { type: "ESModule", path: moduleRoot + "/entry.js", contents: source },
      {
        type: "Data",
        path: moduleRoot + "/frames.bin",
        contents: Buffer.concat(parts),
      },
    ],
  }),
  rows = [];
try {
  await mf.ready;
  let seed = 86731;
  const tasks = Array.from({ length: 5 }, (_, repeat) =>
      ["streams", "native", "native-copy"].map((method) => ({
        repeat,
        method,
        order: (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0),
      })),
    )
      .flat()
      .sort((a, b) => a.order - b.order),
    expected = Array.from(
      { length: iterations },
      (_, i) => frames[i % frames.length].check,
    ).reduce((n, x) => n + x, 0);
  for (const task of tasks) {
    const start = performance.now(),
      response = await mf.dispatchFetch("http://local/?method=" + task.method),
      text = await response.text(),
      clientMs = performance.now() - start;
    if (!response.ok) throw Error(text);
    const result = JSON.parse(text);
    if (result.check !== expected) throw Error("Decompression mismatch");
    rows.push({ ...task, ...result, clientMs });
    console.log(task.method, Math.round(clientMs) + "ms");
  }
  await writeFile(
    output,
    JSON.stringify(
      {
        kind: "Local workerd decompression diagnostic; no storage or search latency claim",
        generation: manifest.generation,
        bytes,
        frames,
        iterations,
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  await mf.dispose();
}
