import { expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { scanText } from "../src/columnar/construction/text.js";
import { tokenOffsets } from "../src/global/build.js";
import {
  CorpusSource,
  type SourceRoot,
} from "../src/columnar/construction/source.js";
import {
  BuildStore,
  ingest,
  merge,
  type Run,
} from "../src/columnar/construction/runs.js";
import {
  finishPostings,
  type FinishState,
} from "../src/columnar/construction/finish.js";
import {
  finishDocuments,
  type DocumentState,
} from "../src/columnar/construction/documents.js";
import { crc32 } from "../src/format/codec.js";
import { type Root, u32, type Ref } from "../src/columnar/format.js";
import { ColumnarIndex } from "../src/columnar/search.js";
import { ColumnarR2 } from "../src/columnar/r2.js";
import { Reader } from "../src/columnar/storage.js";
import { parse, queryTerms } from "../src/query/parser.js";
import { tokenize, type Document } from "../src/query/tokenize.js";
import { exhaustive } from "../bench/columnar/exhaustive.js";
function rankedReference(
  docs: Document[],
  terms: string[],
  field: "all" | "body" | "title",
) {
  const rows = docs.map((d) => ({
      id: d.id,
      b: tokenize(d.body),
      t: tokenize(d.title ?? ""),
    })),
    avgB = rows.reduce((n, r) => n + r.b.length, 0) / docs.length,
    avgT = rows.reduce((n, r) => n + r.t.length, 0) / docs.length;
  const df = terms.map(
    (word) =>
      rows.filter((r) => r.b.includes(word) || r.t.includes(word)).length,
  );
  const score = (tokens: string[], word: string, df: number, avg: number) => {
    const tf = tokens.filter((t) => t === word).length;
    return tf
      ? (Math.log((docs.length + 1) / (df + 0.5)) * tf * 2.2) /
          (tf + 1.2 * (0.25 + (0.75 * tokens.length) / (avg || 1)))
      : 0;
  };
  return rows
    .map((r, doc) => ({
      id: r.id,
      doc,
      score: terms.reduce(
        (n, w, j) =>
          n +
          (field === "title" ? 0 : score(r.b, w, df[j], avgB)) +
          (field === "body" ? 0 : 2 * score(r.t, w, df[j], avgT)),
        0,
      ),
    }))
    .sort((a, b) => b.score - a.score || a.doc - b.doc);
}

export async function fixture(docs: Document[]) {
  const objects = new Map<
      string,
      { bytes: Uint8Array; customMetadata: Record<string, string> }
    >(),
    generation = "a".repeat(64),
    pointers: number[] = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i],
      body = gzipSync(d.body),
      info = new TextEncoder().encode(
        JSON.stringify({ id: d.id, title: d.title, metadata: d.metadata }),
      );
    objects.set(`${generation}/content-${i}.bin`, {
      bytes: body,
      customMetadata: { generation },
    });
    objects.set(`${generation}/info-${i}.bin`, {
      bytes: info,
      customMetadata: { generation },
    });
    pointers.push(
      i,
      0,
      body.length,
      crc32(body),
      i,
      0,
      info.length,
      crc32(info),
    );
  }
  objects.set(`${generation}/contentmap-0.bin`, {
    bytes: u32(pointers),
    customMetadata: { generation },
  });
  const bucket = {
    async get(key: string, options?: any) {
      const o = objects.get(key);
      if (!o) return null;
      const bytes = options?.range
        ? o.bytes.slice(
            options.range.offset,
            options.range.offset + options.range.length,
          )
        : o.bytes;
      return {
        ...o,
        size: o.bytes.length,
        arrayBuffer: async () => Uint8Array.from(bytes).buffer,
      };
    },
    async put(key: string, value: Uint8Array, options?: any) {
      objects.set(key, {
        bytes: Uint8Array.from(value),
        customMetadata: options?.customMetadata ?? {},
      });
    },
  } as unknown as R2Bucket;
  const sourceRoot: SourceRoot = {
    format: "R2-source-v1",
    documents: docs.length,
    parts: [
      {
        part: 0,
        generation,
        first: 0,
        count: docs.length,
        inputSha256: "b".repeat(64),
      },
    ],
  };
  return {
    source: new CorpusSource(bucket, sourceRoot),
    store: new BuildStore(bucket),
    objects,
    bucket,
    sourceRoot,
  };
}
it("scans exact Unicode display offsets without allocating character maps", () => {
  const samples = [
    "",
    "İstanbul ΣΟΣ Σ A😀ﬁ １２３",
    "𝔘nicode\ud800word\udfff ẞ 👩‍🔬",
    "A".repeat(400) + "İ z",
    Array.from({ length: 15000 }, (_, i) =>
      String.fromCodePoint((i * 977) % 0x110000),
    ).join(" "),
  ];
  for (const original of samples) {
    const old = tokenOffsets(original),
      scan = scanText(original),
      tokens = [...scan.tokens()];
    expect(scan.text).toBe(old.text);
    expect(tokens.map((t) => t.word)).toEqual(old.terms);
    expect(tokens.map((t) => t.start)).toEqual(old.starts);
    expect(tokens.map((t) => t.end)).toEqual(old.ends);
  }
});
it("builds the serving format through bounded R2 runs, resumed merges, and finalization; preserves ranking, negatives, snippets and pagination", async () => {
  const docs = Array.from({ length: 600 }, (_, i) => ({
    id: `d${i}`,
    title: i % 3 ? "Court Alpha" : "Gamma",
    body: i % 11 ? "alpha beta common common" : "rare alpha x beta common",
    metadata: { i },
  }));
  docs[7].body = "alpha " + "common ".repeat(1100) + "beta alpha gamma";
  docs[8].body = "Ａlpha İ gamma beta";
  const { source, store, bucket } = await fixture(docs),
    runs: Run[] = [];
  for (let first = 0; first < docs.length;) {
    const run = await ingest(source, store, first, 43, 150);
    runs.push(run);
    first = run.next;
  }
  // Multiple external merge levels and deliberate continuations inside terms.
  while (runs.length > 1) {
    const next: Run[] = [];
    for (let at = 0; at < runs.length; at += 8) {
      const group = runs.slice(at, at + 8);
      if (group.length === 1) {
        next.push(group[0]);
        continue;
      }
      let state;
      const chunks = [];
      do {
        const out = await merge(store, group, state, 777);
        state = out.state;
        chunks.push(...out.chunks);
      } while (!state.done);
      next.push({
        first: group[0].first,
        next: group.at(-1)!.next,
        count: group.reduce((n, r) => n + r.count, 0),
        bodyTokens: group.reduce((n, r) => n + r.bodyTokens, 0),
        titleTokens: group.reduce((n, r) => n + r.titleTokens, 0),
        chunks,
      });
    }
    runs.splice(0, runs.length, ...next);
  }
  const run = runs[0],
    root: Root = {
      format: "CWS1",
      generation: "c".repeat(64),
      corpusHash: "b".repeat(64),
      count: docs.length,
      avgBody: run.bodyTokens / docs.length,
      avgTitle: run.titleTokens / docs.length,
      documents: Array.from(
        { length: Math.ceil(docs.length / 4096) },
        () => [0, 0, 0] as Ref,
      ),
      objects: [],
      hot: {},
      dictionaries: [],
    };
  let state: FinishState | undefined;
  do {
    const out = await finishPostings(
      store,
      run,
      root,
      root.objects.length,
      state,
      3000,
    );
    state = out.state;
    root.objects.push(...out.objects);
  } while (!state.done);
  root.hot = Object.fromEntries(state.hot);
  root.dictionaries = state.dictionaries.at(-1)!;
  root.dictionaryHeight = state.dictionaries.length - 1;
  let documentState: DocumentState | undefined,
    done = false;
  do {
    const out = await finishDocuments(
      source,
      store,
      {
        ...root,
        idRouting: {
          dictionaries: state.ids.dictionaries.at(-1)!,
          dictionaryHeight: state.ids.dictionaries.length - 1,
        },
      },
      root.objects.length,
      documentState,
      100,
    );
    documentState = out.state;
    root.objects.push(...out.objects);
    done = out.done;
  } while (!done);
  root.documents = documentState!.documents;
  expect(root.objects.every(Boolean)).toBe(true);
  const index = new ColumnarIndex(root),
    reader = () => new Reader(root, new ColumnarR2(bucket));
  for (const q of [
    "alpha",
    "common",
    "rare beta",
    "alpha OR gamma",
    "NOT rare",
    'NOT "alpha beta"',
    'common NOT "alpha beta"',
    '"alpha alpha"',
    '"common common common"',
    "alpha /3 beta",
    "(alpha OR gamma) /3 beta",
    "İ",
  ])
    for (const field of ["all", "body", "title"] as const) {
      const terms = queryTerms(parse(q), true),
        matched = new Set(
          docs
            .filter((d) =>
              exhaustive(
                parse(q),
                field === "all"
                  ? [tokenize(d.body), tokenize(d.title)]
                  : [tokenize(d[field])],
              ),
            )
            .map((d) => d.id),
        );
      const ranked = rankedReference(docs, terms, field),
        want = ranked.filter((r) => matched.has(r.id));
      const got = await index.search(q, reader(), { field, limit: 7 });
      expect(
        got.results.map((r) => r.id),
        q + field,
      ).toEqual(want.slice(0, 7).map((r) => r.id));
      got.results.forEach((r, i) => {
        expect(r.score).toBeCloseTo(want[i].score, 11);
        expect(r.metadata).toEqual(docs[Number(r.id.slice(1))].metadata);
        expect(r.snippet).toBeTruthy();
      });
      if (got.results.length) {
        const last = got.results.at(-1)!,
          next = await index.search(q, reader(), {
            field,
            limit: 7,
            after: { score: last.score, doc: last.doc },
          });
        expect(
          next.results.map((r) => r.id),
          q + field + "after",
        ).toEqual(want.slice(7, 14).map((r) => r.id));
      }
    }
  const phrase = await index.search('"beta alpha gamma"', reader());
  expect(phrase.results.map((r) => r.id)).toEqual(["d7"]);
  expect(phrase.results[0].snippet).toContain("beta alpha gamma");
}, 120000);
it("rejects corrupt source content and overlapping merge ranges", async () => {
  const f = await fixture([
      { id: "one", body: "alpha" },
      { id: "two", body: "beta" },
    ]),
    run = await ingest(f.source, f.store, 0, 1);
  await expect(merge(f.store, [run, run])).rejects.toThrow("consecutive");
  f.objects.get("a".repeat(64) + "/content-1.bin")!.bytes[0] ^= 1;
  await expect(f.source.document(1)).rejects.toThrow("checksum");
});
