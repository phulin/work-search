import { readFile } from "node:fs/promises";
import { BuildStore, digest } from "../../src/columnar/construction/runs.js";
import { mergePairStatisticsRuns } from "../../src/columnar/construction/pair-statistics-runs.js";
import { benchmarkToken } from "./token.js";
const state = JSON.parse(
    await readFile(process.argv[2] + "/build.json", "utf8"),
  ),
  store = new BuildStore({} as R2Bucket),
  token = await benchmarkToken();
store.get = async (ref) => {
  const r = await fetch(
    `https://work-search-cws-upload.phulin.workers.dev/${ref.key}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!r.ok) throw Error("Reference read failed");
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length !== ref.size || (await digest(bytes)) !== ref.sha256)
    throw Error("Reference digest mismatch");
  return bytes;
};
store.put = async (bytes) => {
  const sha256 = await digest(bytes);
  return { key: `${sha256}/stage-${sha256}.bin`, size: bytes.length, sha256 };
};
const result = await mergePairStatisticsRuns(
  store,
  state.statistics.slice(0, 4),
);
if (JSON.stringify(result) !== JSON.stringify(state.levels["statistics-0"][0]))
  throw Error("Overlapped merge changed output bytes");
console.log({ unchanged: true, chunks: result.chunks.length });
