import { Miniflare } from "miniflare";
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync, zstdCompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const [dir, output] = process.argv.slice(2);
if (!dir || !output)
  throw Error("Usage: decode.ts MICRO_FIXTURE_DIR RESULTS.json");
const compatibilityDate = process.env.CODEC_COMPAT_DATE ?? "2026-08-06";
const require = createRequire(import.meta.url),
  mfRequire = createRequire(require.resolve("miniflare"));
const runtimePath =
  process.env.MINIFLARE_WORKERD_PATH ?? mfRequire("workerd").default;
const runtimeVersion = execFileSync(runtimePath, ["--version"], {
  encoding: "utf8",
}).trim();
const wasmPath = process.env.CODEC_LZ4_WASM;
const wasm = wasmPath ? await readFile(wasmPath) : null;
const script =
  (wasm
    ? `import lz4Module from './lz4.wasm';
const lz4Instance=new WebAssembly.Instance(lz4Module,{}), lz4Exports=lz4Instance.exports;
function lz4wasm(b){if(b.length>9*1048576)throw Error('LZ4 input');const memory=new Uint8Array(lz4Exports.memory.buffer);memory.set(b,lz4Exports.input_ptr());const n=lz4Exports.decode(b.length);if(n<0)throw Error('LZ4 WASM '+n);return memory.subarray(lz4Exports.output_ptr(),lz4Exports.output_ptr()+n);}
`
    : "") +
  `
import {gunzipSync,inflateRawSync,zstdDecompressSync,brotliDecompressSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {Buffer} from 'node:buffer';
function lz4(b) {
  const size=new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(0,true);
  if(size>8*1048576)throw Error('LZ4 size');
  const out=new Uint8Array(size);let at=4,pos=0;
  while(at<b.length){ const token=b[at++];let literals=token>>>4;
    if(literals===15){let n;do{if(at>=b.length)throw Error('LZ4 literals');n=b[at++];literals+=n;}while(n===255);}
    if(at+literals>b.length||pos+literals>size)throw Error('LZ4 copy');
    out.set(b.subarray(at,at+literals),pos);at+=literals;pos+=literals;
    if(at===b.length)break;
    if(at+2>b.length)throw Error('LZ4 offset'); const offset=b[at]|b[at+1]<<8;at+=2;
    if(offset===0||offset>pos)throw Error('LZ4 offset range');let matches=(token&15)+4;
    if((token&15)===15){let n;do{if(at>=b.length)throw Error('LZ4 matches');n=b[at++];matches+=n;}while(n===255);}
    if(pos+matches>size)throw Error('LZ4 output');for(let i=0;i<matches;i++){out[pos]=out[pos-offset];pos++;}
  }if(pos!==size)throw Error('LZ4 length');return out;
}
export default {async fetch(request) {
 const url=new URL(request.url), codec=url.searchParams.get('codec'), iterations=Number(url.searchParams.get('iterations')||16);
 const bytes=new Uint8Array(await request.arrayBuffer()),view=new DataView(bytes.buffer);let at=0;const data=[];
 while(at<bytes.length){if(at+8>bytes.length)throw Error('header');const raw=view.getUint32(at,true),n=view.getUint32(at+4,true);at+=8;if(at+n>bytes.length)throw Error('payload');data.push([raw,Buffer.from(bytes.buffer,at,n)]);at+=n;}
 const hash=createHash('sha256'),text=new TextDecoder();let chars=0;
 for(let repeat=0;repeat<iterations;repeat++)for(const [size,b] of data){
   let raw;
   if(codec==='gzip-stream'||codec==='deflate-stream')raw=new Uint8Array(await new Response(new Response(b).body.pipeThrough(new DecompressionStream(codec==='gzip-stream'?'gzip':'deflate-raw'))).arrayBuffer());
   else if(codec==='gzip')raw=gunzipSync(b);
   else if(codec==='deflate')raw=inflateRawSync(b);
   else if(codec==='zstd-info')raw=zstdDecompressSync(b,{info:true,maxOutputLength:8*1048576}).buffer;
   else if(codec==='zstd-bounded')raw=zstdDecompressSync(b,{chunkSize:Math.max(64,size+1),maxOutputLength:size+1});
   else if(codec.startsWith('zstd'))raw=zstdDecompressSync(b);
   else if(codec==='brotli-0')raw=brotliDecompressSync(b);
   else if(codec==='lz4-wasm')raw=lz4wasm(b);
   else if(codec==='lz4')raw=lz4(b);
   else if(codec==='none')raw=b;
   else throw Error('codec');
   if(raw.length!==size)throw Error('decoded size');
   if(repeat===0)hash.update(raw);
   const value=JSON.parse(text.decode(raw));chars+=(value.text||value.preview||'').length;
 }
 const digest=hash.digest('hex');if(digest!==request.headers.get('x-expected-sha'))throw Error('decoded bytes mismatch');
 return Response.json({codec,records:data.length,iterations,chars,sha256:digest});
}};`;
const mf = new Miniflare({
  ...(wasm
    ? {
        modules: [
          {
            type: "ESModule" as const,
            path: "codec-worker.mjs",
            contents: script,
          },
          { type: "CompiledWasm" as const, path: "lz4.wasm", contents: wasm },
        ],
      }
    : { script, modules: true }),
  compatibilityDate,
  compatibilityFlags: ["nodejs_compat"],
});
const codecs = [
  "gzip-stream",
  "gzip",
  "deflate-stream",
  "deflate",
  "zstd-1",
  "zstd-info",
  "zstd-fast1",
  "zstd-fast3",
  "lz4",
  "brotli-0",
  "none",
];
type Batch = { body: Buffer; expected: string; records: number };
if (wasm) codecs.push("lz4-wasm");
const batches = new Map<string, Batch>();
function records(b: Buffer) {
  const a: { size: number; b: Buffer }[] = [];
  for (let at = 0; at < b.length;) {
    const size = b.readUInt32LE(at),
      n = b.readUInt32LE(at + 4);
    at += 8;
    a.push({ size, b: b.subarray(at, at + n) });
    at += n;
  }
  return a;
}
for (const kind of [0, 1]) {
  const raw = records(await readFile(dir + `/gzip-${kind}.bin`));
  const selected = Array.from({ length: Math.min(128, raw.length) }, (_, i) =>
    Math.floor((i * raw.length) / Math.min(128, raw.length)),
  );
  const expected = createHash("sha256");
  for (const i of selected) expected.update(gunzipSync(raw[i].b));
  const digest = expected.digest("hex");
  for (const codec of codecs) {
    const name =
        codec === "zstd-info"
          ? "zstd-1"
          : codec === "lz4-wasm"
            ? "lz4"
            : codec.replace("-stream", ""),
      all = records(await readFile(dir + `/${name}-${kind}.bin`));
    if (all.length !== raw.length) throw Error("Fixture record count");
    const chunks = selected.map((i) => {
      const h = Buffer.alloc(8);
      h.writeUInt32LE(all[i].size);
      h.writeUInt32LE(all[i].b.length, 4);
      return Buffer.concat([h, all[i].b]);
    });
    batches.set(`${codec}-${kind}`, {
      body: Buffer.concat(chunks),
      expected: digest,
      records: selected.length,
    });
  }
}
const rows: any[] = [],
  boundaryChecks: any[] = [];
try {
  await mf.ready;
  for (const size of [
    40959, 40960, 40961, 81919, 81920, 81921, 163839, 163840, 163841,
  ]) {
    const raw = Buffer.from(JSON.stringify({ text: "a".repeat(size - 11) }));
    if (raw.length !== size) throw Error("Boundary fixture length");
    const b = zstdCompressSync(raw),
      h = Buffer.alloc(8);
    h.writeUInt32LE(raw.length);
    h.writeUInt32LE(b.length, 4);
    for (const codec of ["zstd-1", "zstd-bounded", "zstd-info"]) {
      const response = await mf.dispatchFetch(
        `http://codec.local/?codec=${codec}&iterations=1`,
        {
          method: "POST",
          body: Buffer.concat([h, b]),
          headers: {
            "x-expected-sha": createHash("sha256").update(raw).digest("hex"),
          },
        },
      );
      boundaryChecks.push({
        codec,
        size,
        status: response.status,
        body: await response.text(),
      });
    }
  }
  const zstdValidation: any[] = [];
  for (const kind of [0, 1]) {
    const gz = records(await readFile(dir + `/gzip-${kind}.bin`)),
      zstd = records(await readFile(dir + `/zstd-1-${kind}.bin`));
    for (let at = 0; at < gz.length; at += 128) {
      const hash = createHash("sha256"),
        chunks: Buffer[] = [];
      for (let i = at; i < Math.min(at + 128, gz.length); i++) {
        hash.update(gunzipSync(gz[i].b));
        const h = Buffer.alloc(8);
        h.writeUInt32LE(zstd[i].size);
        h.writeUInt32LE(zstd[i].b.length, 4);
        chunks.push(h, zstd[i].b);
      }
      const response = await mf.dispatchFetch(
        "http://codec.local/?codec=zstd-info&iterations=1",
        {
          method: "POST",
          body: Buffer.concat(chunks),
          headers: { "x-expected-sha": hash.digest("hex") },
        },
      );
      if (response.status !== 200)
        throw Error("Full zstd validation: " + (await response.text()));
    }
    zstdValidation.push({ kind, records: gz.length, byteExact: true });
  }
  for (const codec of ["zstd-1", "zstd-info"])
    for (const cut of [1, 2, 4, 8]) {
      const raw = Buffer.from(JSON.stringify({ text: "z".repeat(81909) })),
        b = zstdCompressSync(raw),
        truncated = b.subarray(0, b.length - cut),
        h = Buffer.alloc(8);
      h.writeUInt32LE(raw.length);
      h.writeUInt32LE(truncated.length, 4);
      const response = await mf.dispatchFetch(
        `http://codec.local/?codec=${codec}&iterations=1`,
        {
          method: "POST",
          body: Buffer.concat([h, truncated]),
          headers: {
            "x-expected-sha": createHash("sha256").update(raw).digest("hex"),
          },
        },
      );
      boundaryChecks.push({
        codec,
        cut,
        expectedRejection: true,
        status: response.status,
        body: await response.text(),
      });
      if (response.status === 200) throw Error("Truncated zstd accepted");
    }
  if (wasm)
    for (const kind of [0, 1]) {
      const gz = records(await readFile(dir + `/gzip-${kind}.bin`)),
        blocks = records(await readFile(dir + `/lz4-${kind}.bin`));
      for (let at = 0; at < gz.length; at += 128) {
        const hash = createHash("sha256"),
          chunks: Buffer[] = [];
        for (let i = at; i < Math.min(at + 128, gz.length); i++) {
          hash.update(gunzipSync(gz[i].b));
          const h = Buffer.alloc(8);
          h.writeUInt32LE(blocks[i].size);
          h.writeUInt32LE(blocks[i].b.length, 4);
          chunks.push(h, blocks[i].b);
        }
        const response = await mf.dispatchFetch(
          "http://codec.local/?codec=lz4-wasm&iterations=1",
          {
            method: "POST",
            body: Buffer.concat(chunks),
            headers: { "x-expected-sha": hash.digest("hex") },
          },
        );
        if (response.status !== 200)
          throw Error("Full LZ4 validation: " + (await response.text()));
      }
      zstdValidation.push({
        codec: "lz4-wasm",
        kind,
        records: gz.length,
        byteExact: true,
      });
    }
  for (let round = -1; round < 5; round++)
    for (const kind of [0, 1])
      for (const codec of round % 2 === 0 ? codecs : [...codecs].reverse()) {
        const { body, expected } = batches.get(`${codec}-${kind}`)!;
        const t = performance.now();
        const response = await mf.dispatchFetch(
          `http://codec.local/?codec=${codec}&iterations=16`,
          { method: "POST", body, headers: { "x-expected-sha": expected } },
        );
        const result = await response.text(),
          wallMs = performance.now() - t;
        if (response.status !== 200) throw Error(codec + ": " + result);
        if (round >= 0)
          rows.push({
            codec,
            kind: kind === 0 ? "passage" : "display",
            round,
            clientWallMs: wallMs,
            result: JSON.parse(result),
          });
      }
  await writeFile(
    output,
    JSON.stringify(
      {
        kind: "Local workerd decode plus TextDecoder/JSON.parse batches; client wall time includes local dispatch; NOT live Worker latency/CPU; each response verifies full decoded bytes by SHA256 on first iteration",
        compatibilityDate,
        runtimeVersion,
        lz4WasmSha256: wasm
          ? createHash("sha256").update(wasm).digest("hex")
          : null,
        lz4WasmMemoryBytes: wasm ? 18874368 : 0,
        harnessSha256: createHash("sha256")
          .update(await readFile("bench/rust-builder/codecs/decode.ts"))
          .digest("hex"),
        runtimeBinarySha256: createHash("sha256")
          .update(await readFile(runtimePath))
          .digest("hex"),
        miniflareVersion: JSON.parse(
          await readFile(require.resolve("miniflare/package.json"), "utf8"),
        ).version,
        scriptSha256: createHash("sha256").update(script).digest("hex"),
        boundaryChecks,
        zstdValidation,
        rows,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await mf.dispose();
}
console.log(
  JSON.stringify({
    rows: rows.length,
    boundaryErrors: boundaryChecks.filter(
      (r) => !r.expectedRejection && r.status !== 200,
    ),
  }),
);
