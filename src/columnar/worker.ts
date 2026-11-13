import { ColumnarIndex, type Options } from "./search.js";
import { Memory, Reader, Lru, type SharedPages } from "./storage.js";
import { TermDirectory } from "./term-directory.js";
import { DocumentDirectory } from "./document-directory.js";
import { ColumnarR2 } from "./r2.js";
import { QuerySyntaxError } from "../query/parser.js";
import { QueryResourceError } from "../query/evaluate.js";
import type { Root, PairRoot } from "./format.js";
import { Heads, type HeadRoot } from "./heads.js";
interface Env {
  INDEX: R2Bucket;
  INTERNAL_TOKEN?: string;
  CACHE_NAMESPACE?: string;
  PAGE_CACHE?: string;
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
}
export function createColumnarWorker(
  root: Root,
  pairs?: PairRoot,
  heads?: { root: HeadRoot; data: Uint8Array },
  directoryData?: Uint8Array,
  documentDirectoryData?: Uint8Array,
  runtime?: {
    memory: Memory;
    directory: TermDirectory;
    documents?: DocumentDirectory;
  },
) {
  if (pairs && pairs.baseGeneration !== root.generation)
    throw Error("Pair generation mismatch");
  if (
    !!root.directory !== !!directoryData ||
    (root.directory && root.directory.bytes !== directoryData!.length)
  )
    throw Error("Bundled directory mismatch");
  if (
    !!root.documentPackages?.locators !== !!documentDirectoryData ||
    (documentDirectoryData &&
      documentDirectoryData.length !== root.documentPackages!.locators!.bytes)
  )
    throw Error("Bundled document directory mismatch");
  const directory =
      runtime?.directory ??
      (directoryData
        ? new TermDirectory(directoryData, root.count)
        : undefined),
    index = new ColumnarIndex(
      root,
      heads ? new Heads(heads.root, heads.data, root) : undefined,
      directory,
      undefined,
      runtime?.documents ??
        (documentDirectoryData
          ? new DocumentDirectory(documentDirectoryData)
          : undefined),
    ),
    memory = runtime?.memory ?? new Memory();
  if (directoryData) memory.pages = new Lru(12 * 1048576);
  let isolate: string | undefined,
    sequence = 0;
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
      isolate ??= crypto.randomUUID();
      const url = new URL(request.url),
        requestId = url.searchParams.get("requestId") ?? crypto.randomUUID(),
        requestNumber = ++sequence,
        arrival = performance.now();
      if (url.pathname === "/health")
        return Response.json({
          format: root.format,
          generation: root.generation,
          documents: root.count,
          corpusHash: root.corpusHash,
          directoryBytes: root.directory?.bytes,
          isolate,
          sequence,
          cacheNamespace: env.CACHE_NAMESPACE ?? "default",
          pageBytes: 262144,
          version: env.CF_VERSION_METADATA,
        });
      if (url.pathname !== "/search")
        return new Response("Not found", { status: 404 });
      const authorized =
        !!env.INTERNAL_TOKEN &&
        request.headers.get("authorization") === `Bearer ${env.INTERNAL_TOKEN}`;
      try {
        if (request.method !== "GET" && request.method !== "POST")
          return new Response("Method not allowed", { status: 405 });
        let input: any = Object.fromEntries(url.searchParams);
        if (request.method === "POST") {
          const reader = request.body?.getReader();
          let size = 0;
          const chunks: Uint8Array[] = [];
          if (reader)
            for (;;) {
              const r = await reader.read();
              if (r.done) break;
              size += r.value.length;
              if (size > 65536) {
                await reader.cancel();
                return new Response("Request too large", { status: 413 });
              }
              chunks.push(r.value);
            }
          const data = new Uint8Array(size);
          let p = 0;
          for (const c of chunks) {
            data.set(c, p);
            p += c.length;
          }
          input = JSON.parse(new TextDecoder().decode(data));
        }
        if (typeof input.q !== "string")
          throw new QuerySyntaxError("Query required");
        if (input.after && input.generation !== root.generation)
          return Response.json(
            { error: "Search generation changed; restart pagination" },
            { status: 409 },
          );
        const options: Options = {
          limit: Number(input.limit ?? 20),
          field: input.field ?? "all",
          titleBoost: Number(input.titleBoost ?? 2),
          mode: input.mode ?? "and",
          after: input.after,
          metadata: input.metadata !== false && input.metadata !== "false",
          snippets: input.snippets !== false && input.snippets !== "false",
          exactTotal: input.exactTotal === true || input.exactTotal === "true",
        };
        if (
          !Number.isInteger(options.limit) ||
          options.limit! < 1 ||
          options.limit! > 100 ||
          !Number.isFinite(options.titleBoost) ||
          options.titleBoost! < 0 ||
          options.titleBoost! > 20 ||
          !["all", "body", "title"].includes(options.field!) ||
          !["and", "or"].includes(options.mode!)
        )
          throw new QuerySyntaxError("Invalid search options");
        if (
          options.after &&
          (!Number.isFinite(options.after.score) ||
            !Number.isInteger(options.after.doc) ||
            options.after.doc < 0 ||
            options.after.doc >= root.count)
        )
          throw new QuerySyntaxError("Invalid search cursor");
        const namespace =
          authorized &&
          typeof input.cacheNamespace === "string" &&
          /^[a-zA-Z0-9-]{1,64}$/.test(input.cacheNamespace)
            ? input.cacheNamespace
            : (env.CACHE_NAMESPACE ?? "default");
        const shared: SharedPages | undefined =
          env.PAGE_CACHE !== "0"
            ? {
                async get(key) {
                  const r = await (caches as any).default.match(
                    `${url.origin}/__cws/${key}`,
                  );
                  return r?.headers.get("x-cws-validated") === key
                    ? new Uint8Array(await r.arrayBuffer())
                    : undefined;
                },
                async put(key, data) {
                  await (caches as any).default.put(
                    `${url.origin}/__cws/${key}`,
                    new Response(data as BodyInit, {
                      headers: {
                        "cache-control": "public, max-age=31536000, immutable",
                        "x-cws-validated": key,
                      },
                    }),
                  );
                },
              }
            : undefined;
        if (memory.activeQueries >= 2)
          return Response.json(
            { error: "Search capacity busy", requestId, isolate },
            {
              status: 503,
              headers: { "retry-after": "1", "cache-control": "no-store" },
            },
          );
        memory.activeQueries++;
        const execute = async () => {
          // Reset in this search request; a separate reset request could reach
          // another isolate. Admission permits two active requests per isolate.
          if (authorized && input.resetMemory) {
            memory.clear();
            directory?.clear();
          }
          const admitted = performance.now(),
            sharedBudget = { remaining: 900 },
            reader = new Reader(
              root,
              new ColumnarR2(env.INDEX),
              memory,
              shared,
              namespace,
              (p) => ctx.waitUntil(p),
              sharedBudget,
            );
          const pairReader = pairs
            ? new Reader(
                pairs,
                new ColumnarR2(env.INDEX),
                memory,
                shared,
                namespace,
                (p) => ctx.waitUntil(p),
                sharedBudget,
              )
            : undefined;
          const result = await index.search(
            input.q,
            reader,
            options,
            pairs && pairReader
              ? { root: pairs, reader: pairReader }
              : undefined,
          );
          return {
            ...result,
            diagnostics: {
              ...result.diagnostics,
              queueMs: admitted - arrival,
              applicationReset: authorized && !!input.resetMemory,
              namespace,
            },
          };
        };
        let result: Awaited<ReturnType<typeof execute>>;
        try {
          result = await execute();
        } finally {
          memory.activeQueries--;
        }
        const telemetry = {
          requestId,
          isolate,
          requestNumber,
          wallMs: performance.now() - arrival,
          version: env.CF_VERSION_METADATA,
        };
        console.log(JSON.stringify({ benchmark: telemetry }));
        return Response.json(
          {
            results: result.results,
            generation: result.generation,
            ...(options.exactTotal ? { total: result.total } : {}),
            ...(authorized
              ? {
                  diagnostics: result.diagnostics,
                  telemetry,
                  colo: (request as any).cf?.colo,
                }
              : {}),
          },
          {
            headers: { "cache-control": "no-store", "x-request-id": requestId },
          },
        );
      } catch (e) {
        console.log(
          JSON.stringify({
            benchmark: {
              requestId,
              isolate,
              requestNumber,
              wallMs: performance.now() - arrival,
              failed: true,
            },
          }),
        );
        return Response.json(
          {
            error: e instanceof Error ? e.message : String(e),
            requestId,
            isolate,
          },
          {
            status:
              e instanceof QuerySyntaxError || e instanceof SyntaxError
                ? 400
                : e instanceof QueryResourceError
                  ? 422
                  : 503,
            headers: { "cache-control": "no-store" },
          },
        );
      }
    },
  };
}
