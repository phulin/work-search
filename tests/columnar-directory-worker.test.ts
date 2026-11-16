import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { Miniflare } from "miniflare";
import "../scripts/workerd-runtime.js";
import {
  assembleTermDirectory,
  encodeDirectoryBlock,
  type DirectoryTerm,
} from "../src/columnar/term-directory.js";

it("finishes concurrent uncached dictionary lookups in their own Worker requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cws-directory-worker-"));
  let mf: Miniflare | undefined;
  try {
    const entries: [string, DirectoryTerm][] = Array.from(
        { length: 2048 },
        (_, id) => [
          "word" + String(id).padStart(4, "0"),
          {
            id,
            df: 1,
            bodyOccurrences: 1,
            titleOccurrences: 0,
            frequencies: [0, id * 8, 1],
            positional: [0, id * 8, 1],
            tree: {
              first: 0,
              last: 0,
              count: 1,
              height: 0,
              b: 1,
              t: 0,
              score: [0, id * 8, 1],
              positions: [0, id * 8, 1],
              locators: [0, 0, 0],
            },
          },
        ],
      ),
      blocks = [];
    for (let at = 0; at < entries.length; at += 128)
      blocks.push({
        first: entries[at][0],
        count: 128,
        data: gzipSync(encodeDirectoryBlock(entries.slice(at, at + 128))),
      });
    await writeFile(dir + "/directory.bin", assembleTermDirectory(blocks));
    const names = blocks.map((b) => b.first);
    await writeFile(
      dir + "/entry.ts",
      `import bytes from './directory.bin';import{TermDirectory}from ${JSON.stringify(resolve("src/columnar/term-directory.ts"))};const directory=new TermDirectory(new Uint8Array(bytes),1000);export default{async fetch(request){directory.clear();if(new URL(request.url).pathname==='/abandon'){void directory.lookupBundled(${JSON.stringify(names)}).catch(()=>{});return new Response('finished');}const found=await directory.lookupBundled(${JSON.stringify(names)});return Response.json([...found.keys()].sort());}};`,
    );
    await writeFile(
      dir + "/wrangler.json",
      JSON.stringify({
        name: "cws-directory-test",
        main: dir + "/entry.ts",
        compatibility_date: "2026-11-01",
        rules: [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }],
      }),
    );
    const dry = spawnSync(
      "yarn",
      [
        "wrangler",
        "deploy",
        "--config",
        dir + "/wrangler.json",
        "--dry-run",
        "--outdir",
        dir + "/dist",
      ],
      { encoding: "utf8" },
    );
    expect(dry.status, dry.stdout + dry.stderr).toBe(0);
    mf = new Miniflare({
      compatibilityDate: "2026-11-01",
      modules: true,
      modulesRules: [{ type: "Data", include: ["**/*.bin"] }],
      modulesRoot: dir,
      scriptPath: dir + "/dist/entry.js",
    });
    expect(
      (await mf.dispatchFetch("https://directory.test/abandon")).status,
    ).toBe(200);
    const results = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const r = await mf!.dispatchFetch("https://directory.test/");
        return { status: r.status, body: await r.text() };
      }),
    );
    for (const r of results) {
      expect(r.status, r.body).toBe(200);
      expect(JSON.parse(r.body)).toEqual(names);
    }
    const followup = await mf.dispatchFetch("https://directory.test/");
    expect(followup.status).toBe(200);
    expect(await followup.json()).toEqual(names);
  } finally {
    await mf?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
