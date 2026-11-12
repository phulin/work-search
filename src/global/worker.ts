import binary from "../../data/global-plan.bin";
import { createGlobalWorker } from "./worker-runtime.js";
export default createGlobalWorker(new Uint8Array(binary));
