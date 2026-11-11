import { it, expect } from "vitest";
import { Miniflare } from "miniflare";
import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "../src/builder/build.js";
it("executes actual bundled Worker in workerd with local and ranged R2 postings", async () => {
  const dry = spawnSync(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "deploy",
      "--dry-run",
      "--outdir",
      "dist",
    ],
    { encoding: "utf8" },
  );
  expect(dry.status, dry.stdout + dry.stderr).toBe(0);
  const binaryName = (await readFile("dist/index.js", "utf8")).match(
    /["\']\.\/([^"\']+\.bin)["\']/,
  )![1];
  const root = await mkdtemp(join(tmpdir(), "worker-runtime-"));
  await writeFile(
    join(root, "docs"),
    '{"id":"remote","body":"unique common"}\n{"id":"other","body":"common"}',
  );
  const full = await build({
    input: join(root, "docs"),
    out: join(root, "full"),
  });
  const m = await build({
    input: join(root, "docs"),
    out: join(root, "remote"),
    budget: full.bundleBytes - full.embeddedBytes,
  });
  for (const [name, manifest] of [
    ["full", full],
    ["remote", m],
  ] as const) {
    const mf = new Miniflare({
      modules: [
        { type: "ESModule", path: join(process.cwd(), "dist/index.js") },
        {
          type: "Data",
          path: join(process.cwd(), "dist", binaryName),
          contents: await readFile(join(root, name, "bundle.bin")),
        },
      ],
      modulesRoot: process.cwd(),
      scriptPath: join(process.cwd(), "dist/index.js"),
      r2Buckets: ["INDEX"],
      bindings: { DIAGNOSTICS: "true" },
    });
    try {
      const bucket = await mf.getR2Bucket("INDEX");
      for (const o of manifest.objects)
        await bucket.put(
          o.key,
          await readFile(join(root, name, "objects", o.key)),
          { customMetadata: { generation: manifest.generation } },
        );
      const res = await mf.dispatchFetch(
        "https://test/search?q=unique&diagnostics=true",
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.results[0].id).toBe("remote");
      expect(json.diagnostics.indexRequests).toBe(name === "full" ? 0 : 1);
      for (const [q, total] of [
        ['"unique common"', 1],
        ["unique /1 common", 1],
        ["unique /s common", 1],
        ["unique /p common", 1],
        ["unique AND NOT common", 0],
        ['"common unique"', 0],
      ] as const) {
        const response = await mf.dispatchFetch(
          "https://test/search?q=" +
            encodeURIComponent(q) +
            "&diagnostics=true",
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as any;
        expect(body.total, q).toBe(total);
        if (total)
          expect(body.diagnostics.indexRequests).toBe(name === "full" ? 0 : 4);
      }
      expect(
        (
          await mf.dispatchFetch(
            "https://test/search?q=" + encodeURIComponent("unique /0 common"),
          )
        ).status,
      ).toBe(400);
      if (name === "remote") {
        for (const o of manifest.objects)
          if (o.kind === "positions") await bucket.delete(o.key);
        const plain = await mf.dispatchFetch(
          "https://test/search?q=unique&diagnostics=true",
        );
        expect(plain.status).toBe(200);
        const body = (await plain.json()) as any;
        expect(body.total).toBe(1);
        expect(body.diagnostics.positionRequests).toBe(0);
        expect(body.diagnostics.frequencyRequests).toBe(1);
      }
      expect((await mf.dispatchFetch("https://test/health")).status).toBe(200);
    } finally {
      await mf.dispose();
    }
  }
  await rm(root, { recursive: true, force: true });
}, 60000);
