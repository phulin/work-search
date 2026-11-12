// Upgrade an existing directory root using its exact archived bundles; pages do not change.
import { readFile, writeFile } from "node:fs/promises";
import { decodeRoutes, encodeRoutes } from "../src/format/routes.js";
import { openIndex, type PagedIndex } from "../src/format/paged.js";
import { root, object } from "../bench/demo-client.js";
const out = process.argv[2] ?? root + "/routes";
const routes = decodeRoutes(await readFile(out + "/root.bin"))!;
const stats = {
  count: 0,
  bodyTokens: 0,
  titleTokens: 0,
  df: Object.fromEntries(routes.hot.map((t) => [t, 0])),
};
for (const [id, generation] of Object.entries(routes.shards)) {
  let bytes = await readFile(root + "/bundles/" + id + ".bin").catch(
    () => undefined,
  );
  if (!bytes || openIndex(bytes).generation !== generation)
    bytes = Buffer.from(await object(generation + "/bundle-0.bin"));
  const index = openIndex(bytes!) as PagedIndex;
  stats.count += index.count;
  stats.bodyTokens += Math.round(index.count * index.avgBody);
  stats.titleTokens += Math.round(index.count * index.avgTitle);
  for (const term of routes.hot)
    stats.df[term] += index.hotIndex?.lookup(term)?.df ?? 0;
}
routes.stats = stats;
await writeFile(out + "/root.bin", encodeRoutes(routes));
console.log("Added pinned corpus statistics", stats.count);
