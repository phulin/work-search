import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// Miniflare's schema stays stable for existing tooling; use the same pinned
// native runtime as Wrangler rather than its older nested binary.
process.env.MINIFLARE_WORKERD_PATH ??= require("workerd").default;
