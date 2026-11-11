import { SearchRuntime } from "../query/runtime.js";
import binary from "../../data/bundle.bin";
import { BinaryIndex } from "../format/index.js";
import { R2Storage } from "../storage/r2.js";
import { handler } from "./handler.js";
const index = new BinaryIndex(new Uint8Array(binary));
let runtime: SearchRuntime | undefined;
export default {
  fetch(
    request: Request,
    env: { INDEX: R2Bucket; DIAGNOSTICS?: string; CACHE_MIB?: string },
  ) {
    const capacity = Number(env.CACHE_MIB ?? "4") * 1024 * 1024;
    if (!runtime || runtime.capacity !== capacity)
      runtime = new SearchRuntime(capacity);
    return handler(
      index,
      new R2Storage(env.INDEX, index.generation),
      env.DIAGNOSTICS === "true",
      runtime,
    )(request);
  },
};
