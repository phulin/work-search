import { buildColumnarPairs } from "../src/columnar/pair-build.js";
import { benchmarkToken } from "../bench/columnar/token.js";
const dir = process.argv[2];
if (!dir)
  throw Error(
    "Usage: yarn node --import tsx scripts/build-columnar-pairs.ts INDEX_DIR [BUDGET_MIB] [VOCABULARY]",
  );
const remote = process.env.CWS_REMOTE_URL
  ? { url: process.env.CWS_REMOTE_URL, token: await benchmarkToken() }
  : undefined;
const r = await buildColumnarPairs(
  dir,
  Number(process.argv[3] ?? 256) * 1048576,
  Number(process.argv[4] ?? 4096),
  remote,
);
console.log(JSON.stringify({ generation: r.generation, coverage: r.coverage }));
