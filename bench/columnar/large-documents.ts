import { readFile, writeFile } from "node:fs/promises";
import { benchmarkToken } from "./token.js";
const token = await benchmarkToken(),
  url =
    process.env.CWS_BUILD_URL ??
    "https://work-search-cws-build-1.phulin.workers.dev",
  source = JSON.parse(
    await readFile("work/columnar-worker-build/source-samples.json", "utf8"),
  ),
  rows = [];
for (const record of source.largest) {
  const response = await fetch(url + "/ingest", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        build: "large-documents-v1",
        task: `document-${record.doc}`,
        first: record.doc,
        count: 1,
      }),
      signal: AbortSignal.timeout(240000),
    }),
    text = await response.text();
  if (!response.ok)
    throw Error(
      `Large-document ingest ${record.doc} ${response.status}: ${text.slice(0, 1000)}`,
    );
  const result = JSON.parse(text);
  rows.push({ source: record, ...result });
  await writeFile(
    "work/columnar-worker-build/large-document-ingest.json",
    JSON.stringify({ rows }, null, 2),
  );
  console.log(
    "Large R2 document",
    record.doc,
    result.output.bodyTokens,
    "tokens",
    result.telemetry.wallMs,
    "ms",
  );
}
