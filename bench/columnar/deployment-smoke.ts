/** Complete-response deployment validation against local 1M reference results. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import {
  loadServingAssets,
  localServingSource,
  matchesServingHealth,
} from "../../scripts/columnar-serving.js";
import { ColumnarIndex } from "../../src/columnar/search.js";
import { Reader, Memory, Lru } from "../../src/columnar/storage.js";
import { TermDirectory } from "../../src/columnar/term-directory.js";
import { DocumentDirectory } from "../../src/columnar/document-directory.js";
import { MetadataIndex } from "../../src/columnar/metadata-filter.js";
import { LocalObjects } from "./local-storage.js";
import { benchmarkToken } from "./token.js";
const [action, target, contractPath, output] = process.argv.slice(2);
if (!["prepare", "run"].includes(action) || !output)
  throw Error("Use prepare|run INDEX_DIR|URL CONTRACT.json OUTPUT.json");
const assets = await loadServingAssets(
  action === "prepare" ? target : "work/columnar-worker-stem-1m",
  {
    membershipDir:
      process.env.CWS_MEMBERSHIP_DIR ?? "work/columnar-complete-pairs-1m",
    metadataDir: process.env.CWS_METADATA_DIR ?? "work/columnar-metadata-1m",
  },
);
await mkdir(dirname(output), { recursive: true });
if (action === "prepare") {
  const old = JSON.parse(await readFile(contractPath, "utf8"));
  assert.equal(old.corpusHash, assets.root.corpusHash);
  assert.equal(old.analysis, assets.root.analysis);
  const index = new ColumnarIndex(
    assets.root,
    undefined,
    new TermDirectory(assets.directory!, assets.root.count),
    undefined,
    new DocumentDirectory(assets.documents!),
    assets.membership,
  );
  const source = localServingSource(
    new LocalObjects(
      assets.root,
      process.env.CWS_LOCAL_DATA ?? "work/columnar-local-data",
    ),
    assets,
  );
  const memory = new Memory();
  memory.pages = new Lru(12 * 1048576);
  const q = '"summary judgment" AND arbitration AND "third party beneficiary"';
  const filter = {
    and: [
      { field: "date_filed", op: "gte", value: "1990-01-01" },
      { field: "date_filed", op: "lte", value: "2020-12-31" },
      { field: "precedential_status", op: "eq", value: "Published" },
    ],
  };
  const jobs = [
    ...old.scenarios.map((s: any) => ({
      q: s.q,
      options: { ...s.options, limit: 20 },
    })),
    { q, options: { limit: 20, exactTotal: true } },
    { q, options: { limit: 7, exactTotal: true } },
    { q, options: { limit: 14, exactTotal: true, filter } },
    {
      q,
      options: {
        limit: 7,
        exactTotal: true,
        filter: { field: "date_filed", op: "gt", value: "2099-12-31" },
      },
    },
  ];
  const scenarios: any[] = [];
  for (const [i, job] of jobs.entries()) {
    const { filter, ...options } = job.options;
    const reader = new Reader(assets.root, source, memory);
    const result = await index.search(job.q, reader, {
      ...options,
      metadata: true,
      snippets: true,
      documentFilter: filter
        ? new MetadataIndex(assets.metadata!, assets.root).filter(
            filter,
            reader,
          )
        : undefined,
    });
    if (i < old.scenarios.length)
      assert.deepEqual(
        result.results.map((h) => h.id),
        old.scenarios[i].oracle.map((h: any) => h.id),
      );
    scenarios.push({
      q: job.q,
      options: job.options,
      oracle: result.results,
      total: options.exactTotal ? result.total : undefined,
    });
    console.log("Prepared", job.q, result.results.length, result.total);
  }
  const filtered = scenarios.at(-2),
    first = filtered.oracle.slice(0, 7),
    last = first.at(-1);
  filtered.options.limit = 7;
  filtered.oracle = first;
  scenarios.push({
    ...filtered,
    options: {
      ...filtered.options,
      after: { doc: last.doc, score: last.score },
      generation: assets.root.generation,
      metadataGeneration: assets.metadata!.generation,
    },
    oracle: (
      await (async () => {
        const r = new Reader(assets.root, source, memory);
        return index.search(q, r, {
          limit: 14,
          exactTotal: true,
          metadata: true,
          snippets: true,
          documentFilter: new MetadataIndex(
            assets.metadata!,
            assets.root,
          ).filter(filter, r),
        });
      })()
    ).results.slice(7, 14),
  });
  await writeFile(
    output,
    JSON.stringify(
      {
        generation: assets.root.generation,
        corpusHash: assets.root.corpusHash,
        analysis: assets.root.analysis,
        metadataGeneration: assets.metadata!.generation,
        scenarios,
      },
      null,
      2,
    ),
  );
} else {
  const contract = JSON.parse(await readFile(contractPath, "utf8")),
    token = await benchmarkToken(),
    namespace = "smoke-" + randomUUID();
  const health = await fetch(target + "/health").then((r) => r.json());
  assert(matchesServingHealth(assets, health));
  assert.equal(contract.generation, assets.root.generation);
  const rows: any[] = [];
  for (const condition of ["empty-application-fresh-namespace", "repeat"])
    for (const [i, s] of contract.scenarios.entries()) {
      const requestId = randomUUID(),
        start = performance.now();
      const r = await fetch(target + "/search?requestId=" + requestId, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          q: s.q,
          ...s.options,
          cacheNamespace: namespace,
          resetMemory: condition !== "repeat",
          metadata: true,
          snippets: true,
        }),
        signal: AbortSignal.timeout(120000),
      });
      const text = await r.text(),
        ms = performance.now() - start;
      let result: any;
      try {
        result = JSON.parse(text);
      } catch {
        result = { error: text.slice(0, 1000) };
      }
      const row = {
        condition,
        scenario: i,
        requestId,
        q: s.q,
        options: s.options,
        status: r.status,
        ms,
        bytes: Buffer.byteLength(text),
        result,
      };
      rows.push(row);
      await writeFile(
        output,
        JSON.stringify(
          {
            url: target,
            health,
            namespace,
            note: "Deployment smoke validation, not traffic percentiles. Each first-pass request resets application memory; namespace is shared across scenarios, so overlapping shared pages can be reused. Repeat requests may reach different isolates. Opaque R2 caches uncontrolled.",
            rows,
          },
          null,
          2,
        ),
      );
      assert(r.ok, JSON.stringify(row));
      assert.equal(result.generation, contract.generation);
      assert.deepEqual(
        result.results.map((h: any) => h.id),
        s.oracle.map((h: any) => h.id),
      );
      result.results.forEach((h: any, j: number) => {
        const want = s.oracle[j];
        assert(
          Math.abs(h.score - want.score) <=
            1e-8 * Math.max(1, Math.abs(want.score)),
        );
        assert.deepEqual([h.title, h.metadata], [want.title, want.metadata]);
        assert.equal(typeof h.snippet, "string");
        assert(h.snippet.length > 0);
      });
      if (s.options.exactTotal) assert.equal(result.total, s.total);
      console.log(
        condition,
        i,
        ms.toFixed(0) + "ms",
        result.results.length,
        result.total ?? "",
      );
    }
  // Public, unauthenticated clients must receive the same complete result shape.
  const publicResponse = await fetch(target + "/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      q: contract.scenarios[8].q,
      limit: 20,
      exactTotal: true,
    }),
  });
  const publicResult: any = await publicResponse.json();
  assert(publicResponse.ok);
  assert.equal(publicResult.total, 94);
  assert.equal(publicResult.results.length, 20);
  assert.equal(publicResult.diagnostics, undefined);
  assert(
    publicResult.results.every(
      (h: any) => h.metadata && h.title && typeof h.snippet === "string",
    ),
  );
  console.log("All live smoke checks passed");
}
