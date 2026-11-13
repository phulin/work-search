import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildColumnar } from "../bench/columnar/control/offline-build.js";
import { ColumnarIndex } from "../src/columnar/search.js";
import { Heads, headKey } from "../src/columnar/heads.js";
import { Reader } from "../src/columnar/storage.js";
it("certifies complete top-K heads only for exact scoring configurations and falls back for cursors and arbitrary boosts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cws-heads-"));
  try {
    const input = dir + "/input";
    await writeFile(
      input,
      Array.from({ length: 237 }, (_, i) =>
        JSON.stringify({
          id: "d" + i,
          title: i % 5 ? "alpha alpha beta" : "beta",
          body: i % 7 ? "alpha ".repeat((i % 13) + 1) + "beta" : "beta",
          metadata: { i },
        }),
      ).join("\n"),
    );
    const root = await buildColumnar({ input, out: dir + "/index" }),
      script = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/build-columnar-heads.ts", dir + "/index"],
        { encoding: "utf8" },
      );
    expect(script.status, script.stdout + script.stderr).toBe(0);
    const hr = JSON.parse(
        await readFile(dir + "/index/heads-root.json", "utf8"),
      ),
      data = await readFile(dir + "/index/heads.bin"),
      heads = new Heads(hr, data, root),
      packed = new ColumnarIndex(root, heads),
      plain = new ColumnarIndex(root),
      files = await Promise.all(
        root.objects.map((o) => readFile(dir + "/index/packs/" + o.name)),
      );
    const source = {
      async read(key: string, offset: number, length: number) {
        return files[Number(key.match(/plan-(\d+)/)![1])].subarray(
          offset,
          offset + length,
        );
      },
    };
    for (const field of ["all", "body", "title"] as const)
      for (const titleBoost of [0, 2, 3.14159, 20])
        for (const limit of [1, 20, 100]) {
          const opts = { field, titleBoost, limit },
            a = await packed.search("alpha", new Reader(root, source), opts),
            b = await plain.search("alpha", new Reader(root, source), opts);
          expect(a.results).toEqual(b.results);
          expect(a.diagnostics.executor).toBe(
            field === "body" || titleBoost !== 3.14159
              ? "certified-head"
              : "block-max-maxscore",
          );
          const last = a.results.at(-1)!;
          const after = { score: last.score, doc: last.doc };
          expect(
            (
              await packed.search("alpha", new Reader(root, source), {
                ...opts,
                after,
              })
            ).results,
          ).toEqual(
            (
              await plain.search("alpha", new Reader(root, source), {
                ...opts,
                after,
              })
            ).results,
          );
        }
    expect(
      (
        await packed.search("alpha", new Reader(root, source), {
          metadata: false,
          snippets: false,
        })
      ).results[0],
    ).not.toHaveProperty("snippet");
    expect(
      () => new Heads({ ...hr, baseGeneration: "bad" }, data, root),
    ).toThrow("generation");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);
it("finds a combination winner absent from every individual head through the complete executor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cws-seed-"));
  try {
    const docs = Array.from({ length: 8301 }, (_, i) => ({
      id: String(i),
      body:
        i === 8300 ? "alpha beta" : (i < 4160 ? "alpha " : "beta ").repeat(20),
    }));
    await writeFile(
      dir + "/input",
      docs.map((d) => JSON.stringify(d)).join("\n"),
    );
    const root = await buildColumnar({
      input: dir + "/input",
      out: dir + "/index",
    });
    const script = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/build-columnar-heads.ts", dir + "/index"],
      { encoding: "utf8" },
    );
    expect(script.status, script.stdout + script.stderr).toBe(0);
    const hr = JSON.parse(
        await readFile(dir + "/index/heads-root.json", "utf8"),
      ),
      data = await readFile(dir + "/index/heads.bin"),
      heads = new Heads(hr, data, root);
    for (const name of ["alpha", "beta"]) {
      const e = hr.entries[headKey(name, "body", 0)];
      expect(
        Array.from({ length: e.count }, (_, i) =>
          data.readUInt32LE(e.offset + i * 12),
        ),
      ).not.toContain(8300);
    }
    const files = await Promise.all(
        root.objects.map((o) => readFile(dir + "/index/packs/" + o.name)),
      ),
      source = {
        read: async (key: string, offset: number, length: number) =>
          files[Number(key.match(/plan-(\d+)/)![1])].subarray(
            offset,
            offset + length,
          ),
      };
    const accelerated = new ColumnarIndex(root, heads),
      plain = new ColumnarIndex(root);
    for (const q of ["beta OR alpha", "alpha beta", "beta NOT alpha"]) {
      const got = await accelerated.search(q, new Reader(root, source), {
          field: "body",
        }),
        want = await plain.search(q, new Reader(root, source), {
          field: "body",
        });
      expect(got.results).toEqual(want.results);
      if (q !== "beta NOT alpha") expect(got.results[0].id).toBe("8300");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);
