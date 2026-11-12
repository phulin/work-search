import binary from "../data/global-routes.bin";
import gateway from "./gateway-runtime.js";
const bytes = new Uint8Array(binary);
export default {
  fetch(request: Request, env: any) {
    return gateway.fetch(request, { ...env, GLOBAL_ROUTES: bytes });
  },
};
