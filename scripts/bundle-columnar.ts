import { resolve } from "node:path";
import {
  prepareServing,
  servingOptions,
  bundleServing,
} from "./columnar-serving.js";
const dir = resolve(process.argv[2] ?? "indexes/cws"),
  out = resolve("work/columnar-deploy/local");
console.log(
  JSON.stringify(
    await prepareServing(dir, out, "work-search-cws-bundle", servingOptions()),
    null,
    2,
  ),
);
console.log("Compiled module bytes", await bundleServing(out));
