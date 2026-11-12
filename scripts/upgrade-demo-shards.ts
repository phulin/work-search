import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { deploy } from "./deploy-demo.js";
import { parallel } from "../src/storage/types.js";
import { shardCodeHash } from "./shard-code-hash.js";
import { openIndex } from "../src/format/paged.js";
const root = "work/full-flp",
  snapshot = JSON.parse(
    await readFile(
      process.argv.includes("--all")
        ? root + "/published.json"
        : "work/demo-bench/snapshot.json",
      "utf8",
    ),
  );
const shards = process.argv.includes("--all")
  ? Object.values(snapshot.shards)
  : snapshot.shards;
const { url } = JSON.parse(await readFile(root + "/deployment.json", "utf8")),
  { INTERNAL_TOKEN: token } = JSON.parse(
    await readFile(root + "/secrets.json", "utf8"),
  );
const markerRoot = "work/demo-bench/upgraded";
await mkdir(markerRoot, { recursive: true });
const codeHash = await shardCodeHash();
await parallel(shards as any[], 3, async (s) => {
  const marker = await readFile(markerRoot + "/" + s.id, "utf8").then(
    (x) => {
      try {
        return JSON.parse(x);
      } catch {
        return null;
      }
    },
    () => null,
  );
  if (marker?.generation === s.generation && marker?.codeHash === codeHash)
    return;
  const dir = resolve(root + "/upgrade/" + s.id);
  await mkdir(dir, { recursive: true });
  const bytes = await readFile(
    "work/demo-bench/bundles/" + s.id + ".bin",
  ).catch(async () => {
    const r = await fetch(url + "/__index/" + s.generation, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw Error("Archived index unavailable");
    return new Uint8Array(await r.arrayBuffer());
  });
  if (openIndex(bytes).generation !== s.generation)
    throw Error("Upgrade index generation mismatch");
  await writeFile(dir + "/bundle.bin", bytes);
  const module = relative(dir, resolve("demo/shard-runtime.js"))
    .split("\\")
    .join("/");
  await writeFile(
    dir + "/entry.ts",
    `import binary from './bundle.bin';import {createShard} from ${JSON.stringify(module)};export default createShard(new Uint8Array(binary));\n`,
  );
  await deploy(s.worker, dir + "/entry.ts", { SHARD_ID: String(s.id) });
  await writeFile(
    markerRoot + "/" + s.id,
    JSON.stringify({ generation: s.generation, codeHash }),
  );
  await rm(dir, { recursive: true, force: true });
  console.log("Upgraded shard", s.id, s.generation);
});
