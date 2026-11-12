import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
export async function shardCodeHash() {
  const files = ["demo/shard-runtime.ts"];
  for (const dir of ["src/format", "src/query", "src/storage"])
    for (const name of await readdir(dir))
      if (name.endsWith(".ts")) files.push(dir + "/" + name);
  const hash = createHash("sha256");
  for (const file of files.sort())
    hash
      .update(file)
      .update("\0")
      .update(await readFile(file));
  return hash.digest("hex");
}
