import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { courtCaseDecision } from "./court-case-policy.js";
import { constructionHTTP } from "./construction-http.js";
import { benchmarkToken } from "../bench/columnar/token.js";
import type { SourceRoot } from "../src/columnar/construction/source.js";

// Filter the archived corpus without retransferring opinion text. Metadata is
// read in bounded waves; one compact pointer map is written per source part.
const [input, out] = process.argv.slice(2);
if (!input || !out)
  throw Error("Usage: filter-court-source.ts SOURCE_ROOT OUTPUT_DIR");
await mkdir(out, { recursive: true });
const original: SourceRoot = JSON.parse(await readFile(input, "utf8")),
  courts = JSON.parse(
    await readFile("work/full-flp/case-metadata/courts.json", "utf8"),
  ),
  db = new DatabaseSync("work/full-flp/case-metadata.sqlite", {
    readOnly: true,
  }),
  lookup = db.prepare(
    "SELECT d.court FROM cases c LEFT JOIN dockets d ON c.docket=d.id WHERE c.id=?",
  ),
  token = await benchmarkToken(),
  post = constructionHTTP(4),
  url =
    process.env.CWS_BUILD_URL ??
    "https://work-search-cws-build-0.phulin.workers.dev",
  identity = createHash("sha256")
    .update(JSON.stringify(original))
    .update(await readFile("scripts/court-case-policy.ts"))
    .update(await readFile("work/full-flp/case-metadata/courts.json"))
    .update(await readFile("work/full-flp/case-metadata/manifest.json"))
    .digest("hex"),
  root: SourceRoot = { format: "R2-source-v1", documents: 0, parts: [] },
  counts: Record<string, number> = {},
  health = (await fetch(url + "/health", {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json())) as any;
if (
  health.sourceHash !==
  createHash("sha256").update(JSON.stringify(original)).digest("hex")
)
  throw Error("Source filter Worker has a different corpus");
async function call(path: string, value: unknown) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await post(url + path, token, JSON.stringify(value));
      if (!r.ok)
        throw Error(
          path + " " + r.status + " " + (await r.text()).slice(0, 300),
        );
      const result = JSON.parse(await r.text());
      await appendFile(
        out + "/requests.jsonl",
        JSON.stringify({
          at: new Date().toISOString(),
          path,
          telemetry: result.telemetry,
        }) + "\n",
      );
      return result;
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) =>
        setTimeout(r, Math.min(10000, 500 * 2 ** attempt)),
      );
    }
  }
}
try {
  for (const part of original.parts) {
    const checkpoint = out + `/part-${part.part}.json`;
    let saved: any;
    try {
      saved = JSON.parse(await readFile(checkpoint, "utf8"));
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    if (saved && saved.identity !== identity)
      throw Error("Source filter checkpoint changed");
    if (!saved) {
      const selected: number[] = [],
        excluded: Record<string, number> = {};
      for (let at = 0; at < part.count;) {
        const batch = await call("/source-metadata", {
          first: part.first + at,
          count: Math.min(16384, part.count - at),
        });
        if (
          batch.first !== part.first + at ||
          !batch.rows.length ||
          batch.rows.length > Math.min(16384, part.count - at) ||
          batch.next !== part.first + at + batch.rows.length
        )
          throw Error("Source metadata coverage mismatch");
        for (const [i, row] of batch.rows.entries()) {
          const result = (
              Number.isSafeInteger(row.cluster_id) && row.cluster_id > 0
                ? lookup.get(row.cluster_id)
                : undefined
            ) as { court?: string } | undefined,
            court = result?.court,
            decision = courtCaseDecision(court, courts[court ?? ""]);
          if (decision === "include") selected.push(at + i);
          else {
            const reason = decision + ":" + (court ?? "missing");
            excluded[reason] = (excluded[reason] ?? 0) + 1;
          }
        }
        at += batch.rows.length;
      }
      const result = selected.length
        ? await call("/source-filter-map", { part: part.part, selected })
        : undefined;
      const map = result
        ? { key: result.key, size: result.size, sha256: result.sha256 }
        : undefined;
      saved = { identity, selected: selected.length, excluded, map };
      await writeFile(checkpoint + ".tmp", JSON.stringify(saved));
      await rename(checkpoint + ".tmp", checkpoint);
    }
    for (const [k, n] of Object.entries(saved.excluded))
      counts[k] = (counts[k] ?? 0) + (n as number);
    if (saved.selected) {
      root.parts.push({
        ...part,
        first: root.documents,
        count: saved.selected,
        inputSha256: createHash("sha256")
          .update(part.inputSha256 + ":" + saved.map.sha256)
          .digest("hex"),
        pointerMap: saved.map,
      });
      root.documents += saved.selected;
    }
    const progress = {
      identity,
      available: original.documents,
      processed: part.first + part.count,
      documents: root.documents,
      excluded: counts,
      parts: root.parts.length,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(out + "/progress.json", JSON.stringify(progress, null, 2));
    console.log(
      "Court source",
      progress.processed,
      "/",
      original.documents,
      "included",
      root.documents,
    );
  }
  if (!root.documents) throw Error("No court cases selected");
  await writeFile(out + "/source-root.json", JSON.stringify(root, null, 2));
  await writeFile(
    out + "/complete.json",
    JSON.stringify(
      {
        identity,
        documents: root.documents,
        excluded: counts,
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
