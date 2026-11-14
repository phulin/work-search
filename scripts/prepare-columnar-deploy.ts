import { resolve } from "node:path";
import { prepareServing, servingOptions } from "./columnar-serving.js";
const [index, out] = process.argv.slice(2),
  name =
    process.argv[4] && !process.argv[4].startsWith("--")
      ? process.argv[4]
      : "work-search-cws-preview";
if (!index || !out)
  throw Error(
    "Usage: yarn prepare-deploy INDEX_DIR OUTPUT_DIR [WORKER_NAME] [--membership DIR] [--metadata DIR]",
  );
console.log(
  JSON.stringify(
    await prepareServing(resolve(index), resolve(out), name, servingOptions()),
    null,
    2,
  ),
);
