import { readFile, writeFile } from "node:fs/promises";
import { root, snapshot, object } from "./demo-client.js";
import { buildRoutes } from "../src/builder/routes.js";
import { openIndex } from "../src/format/paged.js";
const all = process.argv.includes("--all"),
  out = all ? "work/full-flp/term-routes" : root + "/routes",
  shards = all
    ? (Object.values(
        JSON.parse(await readFile("work/full-flp/published.json", "utf8"))
          .shards,
      ).filter((s: any) => !s.preview) as typeof snapshot.shards)
    : snapshot.shards;
async function retryObject(key: string) {
  for (let attempt = 0; ; attempt++)
    try {
      return await object(key);
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) =>
        setTimeout(r, Math.min(16000, 1000 * 2 ** attempt)),
      );
    }
}
const manifest = await buildRoutes(
  shards,
  async (s) => {
    const local = await readFile(root + "/bundles/" + s.id + ".bin").catch(
      () => undefined,
    );
    return local && openIndex(local).generation === s.generation
      ? local
      : retryObject(s.generation + "/bundle-0.bin");
  },
  (s) => retryObject(s.generation + "/dictionary-0.bin"),
  out,
);
const artifacts = Object.fromEntries(
  manifest.objects.map((o) => [
    manifest.generation + "/" + o.name,
    { path: out + "/" + o.name, size: o.size },
  ]),
);
await writeFile(
  all ? out + "/artifacts.json" : root + "/routes.json",
  JSON.stringify(artifacts),
);
console.log("Built global routes", out, manifest);
