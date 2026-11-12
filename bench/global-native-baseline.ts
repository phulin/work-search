import gateway from "../demo/gateway-runtime.js";
import { context, tracedBucket, tracedService } from "./demo-trace.js";
const aliases = new WeakMap<R2Bucket, R2Bucket>();
function alias(bucket: R2Bucket) {
  let value = aliases.get(bucket);
  if (!value) {
    value = {
      get: (key: string, options: any) =>
        bucket.get(
          key.replace("/cardroot-0.bin", "/globalbenchcardroot-0.bin"),
          options,
        ),
    } as R2Bucket;
    aliases.set(bucket, value);
  }
  return value;
}
export default {
  async fetch(request: Request, env: any) {
    if (request.headers.get("authorization") !== `Bearer ${env.INTERNAL_TOKEN}`)
      return new Response("Not found", { status: 404 });
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ engine: "legacy" });
    const headers = {
      authorization: `Bearer ${env.INTERNAL_TOKEN}`,
      "content-type": "application/json",
    };
    if (url.pathname === "/__reset") {
      aliases.delete(env.INDEX);
      return env.PART.fetch("https://leaf/internal/reset", {
        method: "POST",
        headers,
        body: "{}",
      });
    }
    const input: any = await request.json();
    if (url.pathname === "/warm-term") {
      const q = JSON.stringify(input.term),
        s = (await env.PART.fetch("https://leaf/internal/stats", {
          method: "POST",
          headers,
          body: JSON.stringify({ q }),
        }).then((r: Response) => r.json())) as any;
      return env.PART.fetch("https://leaf/internal/search", {
        method: "POST",
        headers,
        body: JSON.stringify({
          q,
          limit: 100,
          perfLevel: 3,
          generations: s.generations,
          globalStats: {
            count: s.count,
            avgBody: s.bodyTokens / s.count,
            avgTitle: s.titleTokens / s.count,
            df: s.df,
          },
        }),
      });
    }
    const trace = { start: performance.now(), events: [] };
    const start = performance.now();
    const response = await context.run(trace, () =>
      gateway.fetch(
        new Request("https://legacy/api/search", {
          method: "POST",
          body: JSON.stringify(input),
        }),
        {
          ...env,
          ROLE: "root",
          PERF_LEVEL: "3",
          CHILDREN: JSON.stringify([{ binding: "PART", min: 0, max: 0 }]),
          INDEX: tracedBucket(alias(env.INDEX)),
          PART: tracedService(env.PART, "leaf"),
        },
      ),
    );
    const body: any = await response.json();
    return Response.json(
      {
        ...body,
        clientWorkerMs: performance.now() - start,
        diagnostics: {
          requests: trace.events.filter((e: any) => e.type === "r2").length,
          bytes: trace.events.reduce(
            (n: number, e: any) => n + (e.bytes ?? 0),
            0,
          ),
          scope: "gateway only; leaf R2 calls are opaque",
        },
      },
      { status: response.status },
    );
  },
};
