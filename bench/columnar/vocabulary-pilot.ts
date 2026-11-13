import { readFile, writeFile } from "node:fs/promises";
import { deepStrictEqual } from "node:assert/strict";
import { constructionHTTP } from "../../scripts/construction-http.js";
import { benchmarkToken } from "./token.js";
const [directory, output] = process.argv.slice(2);
if (!output) throw Error("Use SOURCE_BUILD OUTPUT.json");
const state = JSON.parse(await readFile(directory + "/build.json", "utf8")),
  token = await benchmarkToken(),
  post = constructionHTTP(1),
  url = "https://work-search-cws-build-0.phulin.workers.dev",
  rows: any[] = [];
for (let group = 0; group < 3; group++) {
  const pair: any[] = [];
  for (const route of group % 2
    ? ["/vocabulary", "/vocabulary-once"]
    : ["/vocabulary-once", "/vocabulary"]) {
    const body = JSON.stringify({
      build: "vocabulary-once-pilot-v1",
      task: `group-${group}-${route.slice(1)}`,
      rootRef: state.rootRef,
      first: group * 1024,
      count: 1024,
    });
    for (let retry = 0; ; retry++) {
      const started = performance.now(),
        r = await post(url + route, token, body),
        text = await r.text();
      if (r.status === 503 && retry < 120) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (!r.ok) throw Error(text);
      const result = JSON.parse(text);
      pair.push(result);
      rows.push({
        route,
        group,
        clientMs: performance.now() - started,
        ...result,
      });
      await writeFile(output, JSON.stringify({ rows }, null, 2));
      console.log(
        route,
        group,
        result.telemetry.wallMs,
        result.output.dictionaryRequests,
        result.output.dictionaryBytes,
      );
      break;
    }
  }
  const essential = (r: any) => ({
    first: r.output.first,
    end: r.output.end,
    words: r.output.words,
    tokens: r.output.tokens,
    vocabulary: r.output.vocabulary,
  });
  deepStrictEqual(essential(pair[0]), essential(pair[1]));
}
await writeFile(
  output,
  JSON.stringify(
    {
      completedAt: new Date().toISOString(),
      note: "Live native constructor pilot under concurrent construction load; exact output bytes checked per pair. Wall time is diagnostic, not an isolated throughput comparison.",
      rows,
    },
    null,
    2,
  ),
);
