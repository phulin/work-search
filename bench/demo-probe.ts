import gateway from "../demo/gateway-runtime.js";
import binary from "../data/global-routes.bin";
const routingBytes = new Uint8Array(binary);
import { parallel } from "../src/storage/types.js";
import {
  context,
  tracedBucket,
  tracedService,
  type Trace,
} from "./demo-trace.js";

export default {
  async fetch(request: Request, env: any) {
    if (
      !env.INTERNAL_TOKEN ||
      request.headers.get("authorization") !== `Bearer ${env.INTERNAL_TOKEN}`
    )
      return new Response("Not found", { status: 404 });
    env = { ...env, GLOBAL_ROUTES: routingBytes };
    const url = new URL(request.url);
    if (url.pathname === "/read") {
      const key = url.searchParams.get("key") ?? "",
        offset = Number(url.searchParams.get("offset") ?? 0),
        length = Number(url.searchParams.get("length") ?? 0);
      if (
        !/^(?:[a-f0-9]{64}\/[a-z]+-\d+\.bin|demo-case-metadata\.json)$/.test(
          key,
        ) ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 1 ||
        length > 4 * 1048576
      )
        return new Response("Invalid range", { status: 400 });
      const start = performance.now(),
        object = await env.INDEX.get(key, { range: { offset, length } }),
        headers = performance.now();
      if (!object) return new Response("Missing", { status: 404 });
      const bytes = await object.arrayBuffer();
      return new Response(bytes, {
        headers: {
          "x-r2-headers-ms": String(headers - start),
          "x-r2-body-ms": String(performance.now() - headers),
          "x-object-size": String(object.size),
          "x-generation": object.customMetadata?.generation ?? "",
          "x-colo": (request as any).cf?.colo ?? "unknown",
          "cache-control": "no-store",
        },
      });
    }
    if (url.pathname === "/latency") {
      const body: any = await request.json();
      if (!Array.isArray(body.reads) || body.reads.length > 500)
        return new Response("Invalid probes", { status: 400 });
      const concurrency = Number(body.concurrency ?? 1);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 24)
        return new Response("Invalid concurrency", { status: 400 });
      const start = performance.now();
      const rows = await parallel(
        body.reads as any[],
        concurrency,
        async (r: any) => {
          if (
            !/^[a-f0-9]{64}\/[a-z]+-\d+\.bin$/.test(r.key) ||
            !Number.isSafeInteger(r.offset) ||
            r.offset < 0 ||
            !Number.isSafeInteger(r.length) ||
            r.length < 1 ||
            r.length > 1048576
          )
            throw Error("Invalid probe range");
          const t = performance.now(),
            o = await env.INDEX.get(r.key, {
              range: { offset: r.offset, length: r.length },
            }),
            h = performance.now();
          if (!o) throw Error("Missing probe object");
          const b = await o.arrayBuffer();
          return {
            ...r,
            start: t - start,
            headersMs: h - t,
            bodyMs: performance.now() - h,
            ms: performance.now() - t,
            bytes: b.byteLength,
          };
        },
      );
      return Response.json({
        rows,
        ms: performance.now() - start,
        colo: (request as any).cf?.colo ?? "unknown",
      });
    }
    if (url.pathname !== "/search")
      return new Response("Not found", { status: 404 });
    const trace: Trace = {
      start: performance.now(),
      events: [],
      colo: (request as any).cf?.colo ?? "unknown",
    };
    const tracedEnv = { ...env, INDEX: tracedBucket(env.INDEX) };
    for (const c of JSON.parse(env.CHILDREN))
      tracedEnv[c.binding] = tracedService(env[c.binding], c.binding);
    return context.run(trace, async () => {
      const response = await gateway.fetch(
        new Request(new URL("/api/search", url), request),
        tracedEnv,
      );
      const body = await response.json();
      return Response.json(
        {
          status: response.status,
          body,
          trace: { ...trace, ms: performance.now() - trace.start },
        },
        { status: response.status },
      );
    });
  },
};
