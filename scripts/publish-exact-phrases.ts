/** Publish only the independently generated exact-phrase data. Base index and
 * membership objects are immutable and already present. Deployment verifies all. */
import { loadServingAssets } from "./columnar-serving.js";
import { publishAuxiliary } from "./columnar-publication.js";
import { benchmarkToken } from "../bench/columnar/token.js";
const [index] = process.argv.slice(2);
if (!index) throw Error("Usage: publish-exact-phrases.ts INDEX");
const assets = await loadServingAssets(index, { membershipDir: index }),
  phrases = assets.membership?.exactPhrases;
if (!phrases) throw Error("Missing exact phrase directory");
const objects = assets.auxiliary.filter((o) =>
  o.key.startsWith(phrases.metadata.generation + "/"),
);
if (objects.length < phrases.metadata.objects.length)
  throw Error("Incomplete pair context inventory");
console.log(
  "Publishing complete pair context generation",
  objects.length,
  objects.reduce((n, o) => n + o.size, 0),
);
await publishAuxiliary(
  "https://work-search-cws-upload.phulin.workers.dev",
  await benchmarkToken(),
  objects,
  index + "/exact-publication.jsonl",
);
