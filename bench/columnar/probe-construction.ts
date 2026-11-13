import { readFile, writeFile } from "node:fs/promises";
import { benchmarkToken } from "./token.js";
const token = await benchmarkToken(),
  root = JSON.parse(
    await readFile("work/columnar-worker-build/source-root.json", "utf8"),
  ),
  rows = [];
const url = "https://work-search-cws-build-0.phulin.workers.dev";
async function call(path: string, body: unknown) {
  for (let retry = 0; ; retry++)
    try {
      const response = await fetch(url + path, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000),
        }),
        result = (await response.json()) as any;
      if (!response.ok) throw Error(JSON.stringify(result));
      return result;
    } catch (e) {
      if (retry === 4) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** retry));
    }
}
for (const part of root.parts) {
  rows.push(await call("/probe", { part: part.part }));
  if (rows.length % 10 === 0)
    console.log("Probed immutable source partitions", rows.length);
  await writeFile(
    "work/columnar-worker-build/source-probe.json",
    JSON.stringify({ at: new Date().toISOString(), rows }, null, 2),
  );
}
const largest = rows
    .flatMap((r) => r.largest)
    .sort((a, b) => b.compressedBytes - a.compressedBytes)
    .slice(0, 8),
  samples = [];
samples.push(await call("/sample", { first: 0, count: 4 }));
for (const d of largest)
  samples.push(await call("/sample", { first: d.doc, count: 1 }));
await writeFile(
  "work/columnar-worker-build/source-samples.json",
  JSON.stringify({ at: new Date().toISOString(), largest, samples }, null, 2),
);
console.log(
  "Validated source",
  root.documents,
  "documents; largest gzip record bytes",
  largest[0].compressedBytes,
);
