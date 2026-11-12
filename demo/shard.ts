import binary from "../data/bundle.bin";
import { createShard } from "./shard-runtime.js";
export default createShard(new Uint8Array(binary));
