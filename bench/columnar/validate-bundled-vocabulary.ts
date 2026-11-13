import { readFile, writeFile } from "node:fs/promises";
import { deepStrictEqual } from "node:assert/strict";
import { benchmarkToken } from "./token.js";
import { constructionHTTP } from "../../scripts/construction-http.js";
const [sourceDir, referenceFile, out] = process.argv.slice(2);
if (!out) throw Error("Use SOURCE_BUILD REFERENCE_PILOT OUTPUT.json");
const state = JSON.parse(await readFile(sourceDir + "/build.json", "utf8")),
  reference = JSON.parse(await readFile(referenceFile, "utf8")),
  token = await benchmarkToken(),
  post = constructionHTTP(1),
  url = "https://work-search-cws-build-0.phulin.workers.dev",
  rows: any[] = [];
for (const baseline of reference.rows.filter(
  (r: any) => r.route === "/vocabulary",
)) {
  const body = JSON.stringify({
    build: process.env.CWS_VOCABULARY_PILOT_ID ?? "vocabulary-bundled-pilot-v1",
    task: `group-${baseline.group}`,
    rootRef: state.rootRef,
    first: baseline.output.first,
    count: 1024,
  });
  for (let retry = 0; ; retry++) {
    const started = performance.now(),
      response = await post(url + "/vocabulary-bundled", token, body),
      text = await response.text();
    if (response.status === 503 && retry < 240) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (!response.ok) throw Error(text);
    const result = JSON.parse(text),
      essential = (r: any) => ({
        first: r.output.first,
        end: r.output.end,
        words: r.output.words,
        tokens: r.output.tokens,
        vocabulary: r.output.vocabulary,
      });
    deepStrictEqual(essential(result), essential(baseline));
    if (result.output.dictionaryRequests || result.output.dictionaryBytes)
      throw Error("Unexpected dictionary I/O");
    rows.push({
      route: "/vocabulary-bundled",
      group: baseline.group,
      clientMs: performance.now() - started,
      ...result,
      baseline,
    });
    await writeFile(out, JSON.stringify({ rows }, null, 2));
    console.log(
      "Bundled vocabulary",
      baseline.group,
      result.telemetry.wallMs,
      "ms",
      result.output.dictionaryRequests,
      "dictionary reads",
      result.telemetry.bytes,
      "source bytes",
    );
    break;
  }
}
await writeFile(
  out,
  JSON.stringify(
    {
      completedAt: new Date().toISOString(),
      rows,
      note: "Live native bundled vocabulary compared byte-for-byte with the frozen remote dictionary constructor. Work reduction is exact; timing is a sequential pilot under concurrent build load.",
    },
    null,
    2,
  ),
);
