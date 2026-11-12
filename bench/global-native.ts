import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { demoWorkload } from "./demo-workload.js";
import { globalWarmup, globalQueries as holdout } from "./global-workload.js";
import { BinaryIndex } from "../src/format/index.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
import { parallel } from "../src/storage/types.js";
const token = JSON.parse(
    await readFile("work/full-flp/secrets.json", "utf8"),
  ).INTERNAL_TOKEN,
  oracle = JSON.parse(await readFile("work/global-bench/oracle.json", "utf8")),
  source = new BinaryIndex(
    await readFile("bench/generated/flp-100000/source/bundle.bin"),
  ),
  disk = new FileStorage("bench/generated/flp-100000/source/objects");
const variants = [
  { name: "work-search-global-old", engine: "old" },
  { name: "work-search-global", page: 64 },
  { name: "work-search-global-p128", page: 128 },
  { name: "work-search-global-p256", page: 256 },
  { name: "work-search-global-heads", page: 256, heads: true },
  {
    name: "work-search-global-smart",
    page: 256,
    heads: true,
    placement: "smart",
  },
  {
    name: "work-search-global-east",
    page: 256,
    heads: true,
    placement: "aws:us-east-1",
  },
];
const rows: any[] = [],
  warmup: any[] = [],
  warmTerms = (() => {
    const db = new DatabaseSync("work/global-100k/terms.sqlite", {
      readOnly: true,
    });
    const ts = db
      .prepare(
        "SELECT term FROM micro WHERE term<>'' ORDER BY df DESC,sort LIMIT 64",
      )
      .all()
      .map((r) => String(r.term));
    db.close();
    return ts;
  })();
async function call(v: (typeof variants)[number], path: string, body?: any) {
  const start = performance.now(),
    r = await fetch(`https://${v.name}.phulin.workers.dev` + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const text = await r.text();
  let b: any;
  try {
    b = JSON.parse(text);
  } catch {
    throw Error(v.name + " " + r.status + " " + text.slice(0, 120));
  }
  if (!r.ok) throw Error(v.name + " " + r.status + " " + text);
  return {
    body: b,
    clientMs: performance.now() - start,
    placement: r.headers.get("cf-placement"),
  };
}
function check(q: string, result: any) {
  const expected = oracle[q];
  if (!expected) throw Error("Missing oracle " + q);
  if (
    result.results.length !== expected.length ||
    result.results.some(
      (r: any, i: number) =>
        r.id !== expected[i].id ||
        Math.abs(r.score - expected[i].score) >
          1e-11 * Math.max(1, Math.abs(expected[i].score)),
    )
  )
    throw Error("Native global ranking mismatch " + q);
  for (let i = 0; i < expected.length; i++)
    if (
      JSON.stringify([result.results[i].title, result.results[i].metadata]) !==
      JSON.stringify([expected[i].title, expected[i].metadata])
    )
      throw Error("Native global card mismatch " + q);
}
async function save() {
  await writeFile(
    "work/global-bench/native.json",
    JSON.stringify({
      kind: "Native 100k corpus, seven interleaved variants, disjoint warmups, unfamiliar and repeated queries; additional corpus-frequency ID-only index priming and memory-reset holdout; no response cache",
      variants,
      rows,
      warmup,
    }),
  );
}
for (const v of variants) {
  for (let attempt = 0; ; attempt++) {
    try {
      const h = await call(v, "/health");
      if (h.body.documents && h.body.documents !== 100000)
        throw Error("Corpus mismatch");
      if (h.body.readPageBytes && h.body.readPageBytes !== v.page! * 1024)
        throw Error("Page config mismatch " + v.name);
      break;
    } catch (e) {
      if (attempt >= 8) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
// Disjoint query warmup; none of the evaluated query strings executes here.
for (const q of globalWarmup
  .slice(0, 8)
  .filter((q: any) => !demoWorkload.some((p) => p.q === q.q)))
  for (const v of variants) {
    const r = await call(v, "/search", { q: q.q, limit: 20 });
    check(q.q, r.body);
    warmup.push({
      phase: "disjoint",
      variant: v.name,
      q: q.q,
      clientMs: r.clientMs,
      diagnostics: r.body.diagnostics,
    });
  }
for (let pass = 0; pass < 3; pass++)
  for (const [qi, q] of demoWorkload.entries()) {
    const order = [
      ...variants.slice((qi + pass) % variants.length),
      ...variants.slice(0, (qi + pass) % variants.length),
    ];
    if (pass % 2) order.reverse();
    for (const v of order) {
      const r = await call(v, "/search", { q: q.q, limit: 20 });
      check(q.q, r.body);
      rows.push({
        phase: pass ? "repeated" : "unfamiliar-after-disjoint",
        pass,
        variant: v.name,
        ...q,
        clientMs: r.clientMs,
        workerMs: r.body.diagnostics?.milliseconds ?? r.body.milliseconds,
        placement: r.placement,
        colo: r.body.colo,
        diagnostics: r.body.diagnostics,
        results: r.body.results.map((h: any) => ({ id: h.id, score: h.score })),
      });
      console.log(pass, v.name, q.q, Math.round(r.clientMs));
      await save();
    }
  }
// Warm only index pages using corpus-derived terms, not future query strings or result records.
const primed = [variants[0], variants[4]];
for (const v of primed)
  await parallel(warmTerms, 3, async (term) => {
    const r = await call(
      v,
      v.engine === "old" ? "/warm-term" : "/search",
      v.engine === "old"
        ? { term }
        : {
            q: JSON.stringify(term),
            limit: 100,
            metadata: false,
            snippets: false,
          },
    );
    if (r.body.results.length !== 100)
      throw Error("Index warmup did not return 100 IDs");
    warmup.push({
      phase: "corpus-id-only",
      variant: v.name,
      term,
      clientMs: r.clientMs,
      diagnostics: r.body.diagnostics,
    });
  });
for (const q of holdout.filter(
  (q: any) => !demoWorkload.some((p) => p.q === q.q),
)) {
  oracle[q.q] = (
    await search(source, disk, q.q, {
      metadata: true,
      internalDoc: true,
      executor: "materialized",
    })
  ).results;
  for (const v of primed) {
    const reset = await fetch(`https://${v.name}.phulin.workers.dev/__reset`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!reset.ok)
      throw Error("Native reset unavailable " + v.name + " " + reset.status);
    const r = await call(v, "/search", { q: q.q, limit: 20 });
    check(q.q, r.body);
    rows.push({
      phase: "unfamiliar-corpus-primed-empty-memory",
      variant: v.name,
      ...q,
      clientMs: r.clientMs,
      workerMs: r.body.diagnostics?.milliseconds ?? r.body.milliseconds,
      placement: r.placement,
      colo: r.body.colo,
      diagnostics: r.body.diagnostics,
      results: r.body.results.map((h: any) => ({ id: h.id, score: h.score })),
    });
    console.log("primed", v.name, q.q, Math.round(r.clientMs));
    await save();
  }
}
await save();
