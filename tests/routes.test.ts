import { it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import {
  encodeRoutes,
  decodeRoutes,
  encodeRoutePage,
  findRouteTerms,
  routeHash,
  ROUTE_BUCKETS,
  TermRoutes,
  possible,
  type RoutesRoot,
} from "../src/format/routes.js";
import { crc32 } from "../src/format/codec.js";
import { parse } from "../src/query/parser.js";
import gateway from "../demo/gateway-runtime.js";
const entry = {
  format: 8,
  term: "rare",
  df: 1,
  object: 0,
  offset: 0,
  length: 8,
  crc: 123,
  positionObject: 0,
  positionOffset: 0,
  positionLength: 4,
  positionCrc: 456,
};
function fixture() {
  const bytes = gzipSync(encodeRoutePage([{ term: "rare", shard: 0, entry }])),
    root: RoutesRoot = {
      version: 1,
      generation: "a".repeat(64),
      shards: { 0: "b".repeat(64), 1: "c".repeat(64) },
      hot: ["court"],
      pages: Array.from({ length: ROUTE_BUCKETS }, () => ({
        object: 0,
        offset: 0,
        length: bytes.length,
        crc: crc32(bytes),
      })),
    };
  let reads = 0;
  const bucket = {
    get: async () => {
      reads++;
      return {
        customMetadata: { generation: root.generation },
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
      };
    },
  } as any;
  return { root, bytes, bucket, reads: () => reads };
}
it("checks routing binary versions, CRCs, Unicode entries and bounded cached page reads", async () => {
  const f = fixture(),
    b = encodeRoutes(f.root);
  expect(decodeRoutes(b)).toEqual(f.root);
  b[15] ^= 1;
  expect(() => decodeRoutes(b)).toThrow();
  expect(decodeRoutes(new Uint8Array(4))).toBeUndefined();
  expect(() =>
    decodeRoutes(encodeRoutes({ ...f.root, version: 2 } as any)),
  ).toThrow();
  const routes = new TermRoutes(f.root);
  expect((await routes.lookup(f.bucket, ["rare"])).rare[0]).toEqual(entry);
  await routes.lookup(f.bucket, ["rare"]);
  expect(f.reads()).toBe(1);
  f.bytes[3] ^= 1;
  await expect(
    new TermRoutes(f.root).lookup(f.bucket, ["rare"]),
  ).rejects.toThrow("checksum");
  const page = encodeRoutePage([
    { term: "法 café", shard: 12, entry: { ...entry, term: "法 café" } },
  ]);
  expect(findRouteTerms(page, new Set(["法 café"]))["法 café"][12].term).toBe(
    "法 café",
  );
  expect(() =>
    findRouteTerms(page.subarray(0, page.length - 1), new Set()),
  ).toThrow();
  expect(routeHash("法 café")).toBe(routeHash("法 café"));
});
it("only prunes provably impossible positive branches, including connectors and negation", () => {
  const present = { rare: entry, missing: null };
  for (const q of [
    "rare",
    "rare OR missing",
    "rare NOT missing",
    "NOT missing",
    "rare /25 rare",
    '"rare rare"',
  ])
    expect(possible(parse(q), present), q).toBe(true);
  for (const q of [
    "missing",
    "rare AND missing",
    "rare /25 missing",
    '"rare missing"',
    "missing NOT rare",
  ])
    expect(possible(parse(q), present), q).toBe(false);
});
it("uses exact covered DFs, includes new generations, pins pagination and conservatively handles old routers", async () => {
  for (const oldRouter of [false, true]) {
    const f = fixture(),
      calls: any[] = [];
    const env: any = {
      ROLE: "root",
      PERF_LEVEL: "3",
      INTERNAL_TOKEN: "test",
      GLOBAL_ROUTES: encodeRoutes(f.root),
      INDEX: f.bucket,
      CHILDREN: JSON.stringify([{ binding: "GROUP", min: 0, max: 2 }]),
      GROUP: {
        fetch: async (url: string, init: RequestInit) => {
          const b = JSON.parse(init.body as string);
          calls.push({ url, b });
          if (url.endsWith("/stats")) {
            const all = {
                0: "b".repeat(64),
                1: "c".repeat(64),
                2: "d".repeat(64),
              },
              gens = b.generations && !oldRouter ? b.generations : all;
            return Response.json({
              apiVersion: 2,
              count: b.q ? Object.keys(gens).length * 10 : 30,
              bodyTokens: 60,
              titleTokens: 0,
              generations: gens,
              df: b.q ? { rare: oldRouter ? 3 : 2 } : {},
            });
          }
          return Response.json({ results: [] });
        },
      },
    };
    const r = await gateway.fetch(
      new Request("https://test/api/search?q=rare"),
      env,
    );
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body.documents).toBe(30);
    const search = calls.find((c) => c.url.endsWith("/search")).b;
    expect(search.generations).toEqual({
      0: "b".repeat(64),
      2: "d".repeat(64),
    });
    expect(search.termHints[0].rare).toEqual(entry);
    expect(search.globalStats.df.rare).toBe(3);
    expect(
      calls.filter((c) => c.url.endsWith("/stats") && c.b.q === "rare").length,
    ).toBe(oldRouter ? 2 : 1);
  }
});
