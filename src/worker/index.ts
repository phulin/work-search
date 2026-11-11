import binary from "../../data/bundle.bin";
import { BinaryIndex } from "../format/index.js";
import { R2Storage } from "../storage/r2.js";
import { handler } from "./handler.js";
const index = new BinaryIndex(new Uint8Array(binary));
export default {
  fetch(request: Request, env: { INDEX: R2Bucket; DIAGNOSTICS?: string }) {
    return handler(
      index,
      new R2Storage(env.INDEX, index.generation),
      env.DIAGNOSTICS === "true",
    )(request);
  },
};
