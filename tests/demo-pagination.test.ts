import { expect, it } from "vitest";
import gateway from "../demo/gateway-runtime.js";

it("keeps a continuation at the demo's maximum page size and pins the next page", async () => {
  const generation = "a".repeat(64),
    calls: any[] = [];
  const env: any = {
    ROLE: "root",
    INTERNAL_TOKEN: "test-only",
    CHILDREN: JSON.stringify([{ binding: "PART", min: 0, max: 0 }]),
    INDEX: { get: async () => null },
    PART: {
      fetch: async (url: string, init: RequestInit) => {
        const b = JSON.parse(init.body as string);
        if (url.endsWith("/stats"))
          return Response.json({
            apiVersion: 2,
            count: 200,
            bodyTokens: 400,
            titleTokens: 0,
            df: { court: 200 },
            generations: { 0: generation },
          });
        if (url.endsWith("/documents")) return Response.json({ results: [] });
        calls.push(b);
        const start = b.after ? b.after.doc + 1 : 0;
        return Response.json({
          results: Array.from({ length: b.limit }, (_, i) => ({
            id: "opinion:" + (start + i),
            doc: start + i,
            shard: 0,
            score: 1,
          })),
        });
      },
    },
  };
  const request = (cursor?: string) =>
    new Request("https://demo/api/search", {
      method: "POST",
      body: JSON.stringify({ q: "court", limit: 50, cursor }),
    });
  const first = (await (await gateway.fetch(request(), env)).json()) as any;
  expect(first.results).toHaveLength(50);
  expect(first.nextCursor).toBeTruthy();
  const second = (await (
    await gateway.fetch(request(first.nextCursor), env)
  ).json()) as any;
  expect(second.results[0].doc).toBe(50);
  expect(
    new Set([...first.results, ...second.results].map((h) => h.id)).size,
  ).toBe(100);
  expect(calls[0].limit).toBe(51);
  expect(calls[1].generations).toEqual({ 0: generation });
  expect(calls[1].globalStats).toEqual(calls[0].globalStats);
});
