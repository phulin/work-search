import { it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/builder/build.js";
import { pageIndex } from "../src/builder/page-index.js";
import { openIndex } from "../src/format/paged.js";
import {
  buildRoutes,
  mergeRouteRows,
  compareRouteRows,
  type RouteRow,
} from "../src/builder/routes.js";
import { decodeRoutes, TermRoutes } from "../src/format/routes.js";
it("externally merges Unicode routing rows with deterministic ties", async () => {
  const rows = ["é", "𐐀", "法", "z", "a"].map(
      (term, i) =>
        ({
          bucket: i % 2,
          term,
          shard: i % 3,
          hot: 1,
          entry: { term },
        }) as RouteRow,
    ),
    a = rows.filter((_, i) => i % 2).sort(compareRouteRows),
    b = rows.filter((_, i) => !(i % 2)).sort(compareRouteRows);
  async function* source(r: RouteRow[]) {
    yield* r;
  }
  const got = [];
  for await (const r of mergeRouteRows([source(a), source(b), source([])]))
    got.push(r);
  expect(got).toEqual(rows.sort(compareRouteRows));
});
it("builds complete resumable corpus-derived routing generations without a workload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "route-build-"));
  try {
    await writeFile(
      dir + "/docs",
      Array.from({ length: 100 }, (_, i) =>
        JSON.stringify({ id: "d" + i, body: "court café token" + i }),
      ).join("\n"),
    );
    await build({ input: dir + "/docs", out: dir + "/old" });
    await pageIndex(dir + "/old", dir + "/index", {
      localTables: true,
      hotDescriptors: 2,
      inlineTiny: true,
    });
    const binary = await readFile(dir + "/index/bundle.bin"),
      index = openIndex(binary),
      shards = [
        { id: 0, generation: index.generation },
        { id: 1, generation: index.generation },
      ],
      dict = await readFile(
        dir + "/index/objects/" + index.generation + "/dictionary-0.bin",
      );
    let downloads = 0;
    const load = async () => {
      downloads++;
      return dict;
    };
    const first = await buildRoutes(
        shards,
        async () => binary,
        load,
        dir + "/routes",
      ),
      second = await buildRoutes(
        [...shards].reverse(),
        async () => binary,
        load,
        dir + "/repeat",
      );
    expect(first).toEqual(second);
    expect(await readFile(dir + "/routes/root.bin")).toEqual(
      await readFile(dir + "/repeat/root.bin"),
    );
    await buildRoutes(
      shards,
      async () => {
        throw Error("Unexpected rebuild");
      },
      async () => {
        throw Error("Unexpected download");
      },
      dir + "/routes",
    );
    expect(downloads).toBe(4);
    const root = decodeRoutes(await readFile(dir + "/routes/root.bin"))!,
      directory = new TermRoutes(root),
      bucket = {
        get: async (key: string, options: any) => {
          const bytes = (
            await readFile(dir + "/routes/" + key.split("/")[1])
          ).subarray(
            options.range.offset,
            options.range.offset + options.range.length,
          );
          return {
            customMetadata: { generation: root.generation },
            arrayBuffer: async () =>
              bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.length,
              ),
          };
        },
      } as any;
    const got = await directory.lookup(bucket, ["court", "token99", "missing"]);
    expect(Object.values(got.court).reduce((n, e) => n + e.df, 0)).toBe(200);
    expect(Object.values(got.token99).reduce((n, e) => n + e.df, 0)).toBe(2);
    expect(got.missing).toEqual({});
    expect(root.hot).toContain("court");
    expect(root.stats?.df.court).toBe(200);
    expect(root.stats?.count).toBe(200);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
