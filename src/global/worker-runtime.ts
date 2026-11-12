import { GlobalIndex } from "./search.js";
import { PageReader, workerPageCache, HttpPageStorage } from "./storage.js";
import { R2Storage } from "../storage/r2.js";
import { SearchRuntime } from "../query/runtime.js";
import { QuerySyntaxError } from "../query/parser.js";
import { QueryResourceError } from "../query/evaluate.js";
interface Env {
  INDEX: R2Bucket;
  PAGE_CACHE?: string;
  PAGE_CACHE_POLICY?: "fixed384" | "adaptive960";
  COMPETITIVE_POSITIONS?: string;
  PAGE_READ_KIB?: string;
  PAGE_BASE_URL?: string;
  DIAGNOSTICS?: string;
  INTERNAL_TOKEN?: string;
}
export function createGlobalWorker(bytes: Uint8Array) {
  const index = new GlobalIndex(bytes),
    memory = new SearchRuntime(8 * 1048576);
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
      const url = new URL(request.url);
      if (url.pathname === "/health")
        return Response.json({
          version: 1,
          generation: index.root.generation,
          documents: index.root.count,
          pageBytes: index.root.pageBytes,
          readPageBytes:
            Number(env.PAGE_READ_KIB ?? index.root.pageBytes / 1024) * 1024,
          bundleBytes: bytes.length,
          cache: env.PAGE_BASE_URL
            ? "cdn"
            : env.PAGE_CACHE === "1"
              ? "memory+colo-cache+r2"
              : "memory+r2",
        });
      if (
        url.pathname === "/__reset" &&
        env.INTERNAL_TOKEN &&
        request.headers.get("authorization") === `Bearer ${env.INTERNAL_TOKEN}`
      ) {
        memory.clear();
        return new Response("Reset");
      }
      if (url.pathname !== "/search")
        return new Response(
          "Global search prototype: /search?q=summary+judgment and /health",
          { status: 404 },
        );
      try {
        let input: any = Object.fromEntries(url.searchParams);
        if (request.method === "POST") {
          if (Number(request.headers.get("content-length") ?? 0) > 65536)
            return new Response("Request too large", { status: 413 });
          let text = "",
            size = 0;
          const reader = request.body?.getReader(),
            decoder = new TextDecoder();
          if (reader) {
            try {
              for (;;) {
                const r = await reader.read();
                if (r.done) break;
                size += r.value.length;
                if (size > 65536) {
                  await reader.cancel();
                  return new Response("Request too large", { status: 413 });
                }
                text += decoder.decode(r.value, { stream: true });
              }
              text += decoder.decode();
            } finally {
              reader.releaseLock();
            }
          }
          input = JSON.parse(text);
        }
        if (typeof input.q !== "string" || input.q.length > 2048)
          throw new QuerySyntaxError(
            "A query up to 2048 characters is required",
          );
        if (input.after && input.generation !== index.root.generation)
          return Response.json(
            { error: "Search generation changed; restart pagination" },
            { status: 409 },
          );
        const limit = Number(input.limit ?? 20),
          titleBoost = Number(input.titleBoost ?? 2);
        if (
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100 ||
          !Number.isFinite(titleBoost) ||
          titleBoost < 0 ||
          titleBoost > 20
        )
          throw new QuerySyntaxError("Invalid limit or title boost");
        const field = input.field ?? "all";
        if (!["all", "body", "title"].includes(field))
          throw new QuerySyntaxError("Invalid field");
        const authorized =
          !!env.INTERNAL_TOKEN &&
          request.headers.get("authorization") ===
            `Bearer ${env.INTERNAL_TOKEN}`;
        if (authorized && input.resetMemory) memory.clear();
        const pageBytes =
          Number(env.PAGE_READ_KIB ?? index.root.pageBytes / 1024) * 1024;
        if (![65536, 131072, 262144].includes(pageBytes))
          throw Error("Invalid page read size");
        const pageRoot = {
          ...index.root,
          pageBytes,
          objectPages: (64 * 1048576) / pageBytes,
        };
        const defer = (p: Promise<unknown>) => ctx.waitUntil(p),
          cache =
            env.PAGE_CACHE === "1"
              ? workerPageCache(
                  (caches as unknown as { default: Cache }).default,
                  url.origin,
                  defer,
                )
              : undefined;
        const source = env.PAGE_BASE_URL
            ? new HttpPageStorage(pageRoot, env.PAGE_BASE_URL)
            : new R2Storage(env.INDEX, index.root.generation),
          reader = new PageReader(
            pageRoot,
            source,
            memory,
            cache,
            defer,
            true,
            env.PAGE_CACHE_POLICY,
          );
        const result = await index.search(reader, input.q, {
          limit,
          field,
          titleBoost,
          metadata: input.metadata !== false && input.metadata !== "false",
          snippets: input.snippets !== false && input.snippets !== "false",
          after: input.after,
          competitivePositions: env.COMPETITIVE_POSITIONS === "1",
        });
        const diagnostics =
          env.DIAGNOSTICS === "1" ||
          (!!env.INTERNAL_TOKEN &&
            request.headers.get("authorization") ===
              `Bearer ${env.INTERNAL_TOKEN}`);
        return Response.json({
          results: result.results,
          ...(diagnostics
            ? {
                diagnostics: result.diagnostics,
                colo: (request as any).cf?.colo,
              }
            : {}),
          generation: index.root.generation,
        });
      } catch (e) {
        return Response.json(
          { error: e instanceof Error ? e.message : "Search failed" },
          {
            status:
              e instanceof QuerySyntaxError || e instanceof SyntaxError
                ? 400
                : e instanceof QueryResourceError
                  ? 422
                  : 503,
          },
        );
      }
    },
  };
}
