import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { build } from "../src/builder/build.js";
import { BinaryIndex } from "../src/format/index.js";
import { search, bm25 } from "../src/query/engine.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { tokenize } from "../src/query/tokenize.js";
import { parse, queryTerms } from "../src/query/parser.js";
import { positionalMatcher } from "../src/query/evaluate.js";
import type { DecodedPostings } from "../src/format/codec.js";
import {
  decodeBranches,
  decodeScores,
  unpack,
  view,
  refAt,
  type Ref,
  type Root,
  type Term,
  type Branch,
} from "../bench/rust-builder/control/format.js";
const binary = resolve("target/release/work-search-builder");
async function run(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (ok, no) => {
      const c = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "",
        stderr = "";
      c.stdout.on("data", (b) => (stdout += b));
      c.stderr.on("data", (b) => (stderr += b));
      c.once("error", no);
      c.once("exit", (code) => ok({ code, stdout, stderr }));
    },
  );
}
it("Rust output preserves every posting, float64 score within tolerance, forward token, display record, AST ranking and pagination", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rust-index-"));
  try {
    const docs = Array.from({ length: 8401 }, (_, i) => ({
      id: "d" + i,
      title: i % 3 ? "Alpha Beta" : "Σ İ 𝔄 ＨＥＬＬＯ",
      body:
        i % 29 === 0
          ? "rare alpha beta alpha gamma " + "common ".repeat(i % 40)
          : i % 7 === 0
            ? "beta alpha alpha gamma common"
            : i % 5 === 0
              ? "alpha gamma beta common"
              : "beta common common",
      metadata: i === 0 ? null : { i },
    }));
    docs[102].body = "alpha\u2028beta";
    docs[100].id = "😀";
    docs[101].id = "\ue000";
    docs[17].body = "alpha " + "common ".repeat(10000) + "beta alpha gamma";
    docs[100].body += " \ufdfa \u{20000} 切";
    const input = dir + "/corpus.jsonl";
    await writeFile(input, docs.map((d) => JSON.stringify(d)).join("\n"));
    const out = dir + "/rust";
    const result = await run([
      "build",
      "--input",
      input,
      "--out",
      out,
      "--threads",
      "4",
      "--batch-mib",
      "1",
    ]);
    expect(result.code, result.stderr).toBe(0);
    const root: Root = JSON.parse(await readFile(out + "/root.json", "utf8"));
    expect(root.count).toBe(docs.length);
    const files = new Map<number, Buffer>();
    const read = async (r: Ref) => {
      let b = files.get(r[0]);
      if (!b) {
        b = await readFile(out + "/packs/" + root.objects[r[0]].name);
        files.set(r[0], b);
      }
      return b.subarray(r[1], r[1] + r[2]);
    };
    for (const o of root.objects) {
      expect(
        createHash("sha256")
          .update(await readFile(out + "/packs/" + o.name))
          .digest("hex"),
      ).toBe(o.sha256);
    }
    const terms = new Map<string, Term>();
    for (const d of root.dictionaries)
      for (const [n, t] of JSON.parse(
        new TextDecoder().decode(await read(d.ref)),
      ))
        terms.set(n, t);
    const records = docs.map((d) => ({
      b: tokenize(d.body),
      t: tokenize(d.title),
    }));
    const lists = new Map<string, DecodedPostings>();
    const values = new Map<string, Map<number, [number, number]>>();
    const positions = new Map<
      string,
      Map<number, [Uint32Array, Uint32Array]>
    >();
    async function leaves(b: Branch): Promise<Branch[]> {
      if (!b.height) return [b];
      const children = decodeBranches(await read(b.score));
      expect(children.length).toBeGreaterThan(0);
      expect(children[0].first).toBe(b.first);
      expect(children.at(-1)!.last).toBe(b.last);
      expect(children.reduce((n, c) => n + c.count, 0)).toBe(b.count);
      children.forEach((c, i) => {
        expect(c.height).toBe(b.height - 1);
        expect(c.b).toBeLessThanOrEqual(b.b);
        expect(c.t).toBeLessThanOrEqual(b.t);
        if (i) expect(c.first).toBeGreaterThan(children[i - 1].last);
      });
      return (await Promise.all(children.map(leaves))).flat();
    }
    for (const [name, t] of terms) {
      const ds: number[] = [],
        bs: number[] = [],
        ts: number[] = [];
      const scores = new Map<number, [number, number]>();
      const ps = new Map<number, [Uint32Array, Uint32Array]>();
      for (const block of await leaves(t.tree)) {
        const s = decodeScores(await read(block.score));
        const raw = await read(block.positions),
          v = view(raw),
          n = v.getUint32(0, true),
          base = 4 + (n + 1) * 4;
        expect(n).toBe(s.docs.length);
        expect(block.count).toBe(n);
        expect(block.first).toBe(s.docs[0]);
        expect(block.last).toBe(s.docs[n - 1]);
        for (let i = 0; i < n; i++) {
          expect(s.b.getFloat64(i * 8, true)).toBeLessThanOrEqual(block.b);
          expect(s.t.getFloat64(i * 8, true)).toBeLessThanOrEqual(block.t);
        }
        for (let i = 0; i < n; i++) {
          const doc = s.docs[i];
          ds.push(doc);
          bs.push(s.body[i]);
          ts.push(s.title[i]);
          const b = s.b.getFloat64(i * 8, true),
            title = s.t.getFloat64(i * 8, true);
          expect(b).toBeCloseTo(
            bm25(
              s.body[i],
              t.df,
              docs.length,
              records[doc].b.length,
              root.avgBody,
            ),
            13,
          );
          expect(title).toBeCloseTo(
            bm25(
              s.title[i],
              t.df,
              docs.length,
              records[doc].t.length,
              root.avgTitle,
            ),
            13,
          );
          scores.set(doc, [b, title]);
          const from = base + v.getUint32(4 + i * 4, true),
            end = base + v.getUint32(8 + i * 4, true),
            blen = v.getUint32(from, true);
          const bp = unpack(raw.subarray(from + 4, from + 4 + blen)),
            tp = unpack(raw.subarray(from + 4 + blen, end));
          expect([...bp]).toEqual(
            records[doc].b.flatMap((x, i) => (x === name ? [i] : [])),
          );
          expect([...tp]).toEqual(
            records[doc].t.flatMap((x, i) => (x === name ? [i] : [])),
          );
          ps.set(doc, [bp, tp]);
        }
      }
      expect(ds.length).toBe(t.df);
      lists.set(name, {
        docs: Uint32Array.from(ds),
        body: Uint32Array.from(bs),
        title: Uint32Array.from(ts),
        bytes: new Uint8Array(0),
      });
      values.set(name, scores);
      positions.set(name, ps);
    }
    for (const doc of [0, 17, 100, 4095, 4096, 8191, 8400]) {
      const table = view(await read(root.documents[Math.floor(doc / 4096)])),
        at = (doc % 4096) * 36;
      const record = JSON.parse(
        gunzipSync(await read(refAt(table, at))).toString(),
      );
      expect(record.id).toBe(docs[doc].id);
      expect(record.title).toBe(docs[doc].title);
      expect(record.metadata).toEqual(docs[doc].metadata);
      const f = view(await read(refAt(table, at + 12)));
      const ids: number[] = [];
      for (let p = 0; p < f.byteLength; p += 32) {
        const first = f.getUint32(p, true);
        const tokens = unpack(await read(refAt(f, p + 8)));
        const core = Math.floor(p / 32) * 256;
        ids.push(
          ...[...tokens].slice(
            core - first,
            core - first + Math.min(256, records[doc].b.length - core),
          ),
        );
        const text = JSON.parse(
          gunzipSync(await read(refAt(f, p + 20))).toString(),
        );
        expect(text.first).toBe(first);
      }
      expect(ids).toEqual(records[doc].b.map((t) => terms.get(t)!.id));
    }
    await build({ input, out: dir + "/oracle" });
    const oracle = new BinaryIndex(await readFile(dir + "/oracle/bundle.bin")),
      disk = new FileStorage(dir + "/oracle/objects");
    for (const q of [
      "alpha",
      "common",
      "rare common",
      "alpha OR beta",
      "NOT rare",
      'NOT "alpha beta"',
      'NOT NOT "alpha beta"',
      'common NOT "alpha beta"',
      '"alpha alpha"',
      '"alpha beta alpha"',
      "alpha /3 beta",
      "(rare OR alpha) /5 gamma",
      "(alpha AND NOT rare) /3 beta",
      '(alpha /2 beta) NOT "alpha gamma"',
      "NOT unknown",
      "unknown",
      "Σ OR hello",
    ])
      for (const field of ["all", "body", "title"] as const) {
        const ast = parse(q),
          positive = queryTerms(ast, true),
          match = positionalMatcher(
            ast,
            lists,
            field,
            (t, d, f) => positions.get(t)?.get(d)?.[f],
          );
        const ranked = [];
        for (let doc = 0; doc < docs.length; doc++)
          if (match(doc)) {
            let score = 0;
            for (const t of positive) {
              const v = values.get(t)?.get(doc);
              if (v)
                score +=
                  (field !== "title" ? v[0] : 0) +
                  (field !== "body" ? 3.25 * v[1] : 0);
            }
            ranked.push({ doc, id: docs[doc].id, score });
          }
        ranked.sort((a, b) => b.score - a.score || a.doc - b.doc);
        const want = await search(oracle, disk, q, {
          field,
          titleBoost: 3.25,
          limit: 7,
          exactTotal: true,
          internalDoc: true,
        });
        expect(
          ranked.slice(0, 7).map((h) => h.id),
          q + ":" + field,
        ).toEqual(want.results.map((h) => h.id));
        ranked
          .slice(0, 7)
          .forEach((h, i) =>
            expect(h.score).toBeCloseTo(want.results[i].score, 11),
          );
        if (ranked.length >= 7) {
          const last = ranked[6];
          const next = await search(oracle, disk, q, {
            field,
            titleBoost: 3.25,
            limit: 7,
            exactTotal: true,
            internalDoc: true,
            // Each generation must paginate using its own float64 cursor;
            // native ln and V8 may differ in their least significant bits.
            after: { score: want.results[6].score, doc: last.doc },
          });
          expect(
            ranked
              .filter(
                (h) =>
                  h.score < last.score ||
                  (h.score === last.score && h.doc > last.doc),
              )
              .slice(0, 7)
              .map((h) => h.id),
          ).toEqual(next.results.map((h) => h.id));
        }
      }
    const deterministic = dir + "/single-thread";
    const serial = await run([
      "build",
      "--input",
      input,
      "--out",
      deterministic,
      "--threads",
      "1",
      "--batch-mib",
      "1",
    ]);
    expect(serial.code, serial.stderr).toBe(0);
    expect(
      JSON.parse(await readFile(deterministic + "/root.json", "utf8"))
        .generation,
    ).toBe(root.generation);
    const rootBefore = await readFile(out + "/root.json");
    const resumed = await run([
      "build",
      "--input",
      input,
      "--out",
      out,
      "--threads",
      "1",
      "--batch-mib",
      "1",
      "--resume",
    ]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(await readFile(out + "/root.json")).toEqual(rootBefore);
    const dup = dir + "/duplicate.jsonl";
    await writeFile(
      dup,
      '{"id":"same","body":"a"}\n{"id":"same","body":"b"}\n',
    );
    const d = await run(["build", "--input", dup, "--out", dir + "/dup"]);
    expect(d.code).toBe(1);
    expect(d.stderr).toContain("duplicate document ID");
    await expect(readFile(dir + "/dup/root.json")).rejects.toThrow();
    const checkpoint = out + "/staging/run-000000/postings.stage";
    await writeFile(checkpoint, "corrupt");
    const broken = await run([
      "build",
      "--input",
      input,
      "--out",
      out,
      "--batch-mib",
      "1",
      "--resume",
    ]);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain("checksum mismatch");
    expect(await readFile(out + "/root.json")).toEqual(rootBefore);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);

it("builds documents with no indexable terms and still provides metadata and forward locators", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rust-empty-"));
  try {
    const input = dir + "/input.jsonl";
    await writeFile(
      input,
      '{"id":"empty","body":"","metadata":null}\n{"id":"symbols","body":"★—…"}\n',
    );
    const result = await run([
      "build",
      "--input",
      input,
      "--out",
      dir + "/out",
    ]);
    expect(result.code, result.stderr).toBe(0);
    const root: Root = JSON.parse(
      await readFile(dir + "/out/root.json", "utf8"),
    );
    expect(root.count).toBe(2);
    expect(root.dictionaries).toEqual([]);
    expect(root.documents.length).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("external posting merge works under a low descriptor limit", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "rust-lowfd-"));
  try {
    const input = dir + "/corpus.jsonl";
    const docs = Array.from({ length: 90 }, (_, i) => ({
      id: "d" + i,
      body: "alpha beta ".repeat(6000),
    }));
    await writeFile(input, docs.map((d) => JSON.stringify(d)).join("\n"));
    const code = await new Promise<number | null>((ok, no) => {
      const child = spawn(
        "/bin/sh",
        [
          "-c",
          'ulimit -n 66; exec "$@"',
          "rust-builder",
          binary,
          "build",
          "--input",
          input,
          "--out",
          dir + "/out",
          "--threads",
          "2",
          "--batch-mib",
          "1",
        ],
        { stdio: "ignore" },
      );
      child.once("error", no);
      child.once("exit", ok);
    });
    expect(code).toBe(0);
    const root: Root = JSON.parse(
      await readFile(dir + "/out/root.json", "utf8"),
    );
    expect(root.count).toBe(90);
    const manifest = JSON.parse(
      await readFile(dir + "/out/manifest.json", "utf8"),
    );
    expect(manifest.runs).toBeGreaterThan(2);
    const dict = root.dictionaries[0].ref;
    const dictionary = JSON.parse(
      (await readFile(dir + "/out/packs/" + root.objects[dict[0]].name))
        .subarray(dict[1], dict[1] + dict[2])
        .toString(),
    ) as [string, Term][];
    expect(
      dictionary.map(([name, term]) => [name, term.df, term.tree.count]),
    ).toEqual([
      ["alpha", 90, 90],
      ["beta", 90, 90],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
