import { createColumnarWorker } from "../../src/columnar/worker.js";
import { TermDirectory } from "../../src/columnar/term-directory.js";
import { DocumentDirectory } from "../../src/columnar/document-directory.js";
import {
  executePackets,
  packetPlan,
  type PacketPlan,
} from "../../src/columnar/packet-execution.js";
import { parse, queryTerms, simplify } from "../../src/query/parser.js";
import {
  Memory,
  Reader,
  Lru,
  type SharedPages,
} from "../../src/columnar/storage.js";
import { ColumnarR2 } from "../../src/columnar/r2.js";
import type { Root } from "../../src/columnar/format.js";
/** Explicit plan comparisons live only in this benchmark entry point. The
 * ordinary search route retains the production cost-based planner. */
export function createPacketBenchmarkWorker(
  root: Root,
  data: Uint8Array,
  documentData?: Uint8Array,
) {
  const normal = createColumnarWorker(
      root,
      undefined,
      undefined,
      data,
      documentData,
    ),
    documents = documentData ? new DocumentDirectory(documentData) : undefined,
    directory = new TermDirectory(data, root.count),
    memory = new Memory();
  memory.pages = new Lru(12 * 1048576);
  let isolate: string | undefined;
  return {
    async fetch(request: Request, env: any, ctx: ExecutionContext) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/__benchmark/"))
        return normal.fetch(request, env, ctx);
      isolate ??= crypto.randomUUID();
      if (
        !env.INTERNAL_TOKEN ||
        request.headers.get("authorization") !== `Bearer ${env.INTERNAL_TOKEN}`
      )
        return new Response("Forbidden", { status: 403 });
      // Keep one real invocation active during the native sampling interval.
      // This route is diagnostic only; each iteration executes and consumes a
      // complete ordinary search response, without response caching.
      if (url.pathname === "/__benchmark/profile") {
        const input: any = await request.json(),
          duration = Number(input.durationMs ?? 30000);
        if (!Number.isFinite(duration) || duration < 1000 || duration > 45000)
          return new Response("Invalid profile duration", { status: 400 });
        const started = performance.now(),
          profileId = crypto.randomUUID();
        let calls = 0,
          bytes = 0,
          last = "";
        do {
          const search = new URL("/search", url.origin);
          search.searchParams.set("requestId", `${profileId}-${calls}`);
          const response = await normal.fetch(
            new Request(search, {
              method: "POST",
              headers: request.headers,
              body: JSON.stringify({
                q: input.q,
                ...input.options,
                resetMemory: input.resetMemory ?? false,
              }),
            }),
            env,
            ctx,
          );
          last = await response.text();
          bytes += last.length;
          calls++;
          if (!response.ok)
            return Response.json(
              { profileId, calls, error: last },
              { status: 500 },
            );
        } while (performance.now() - started < duration);
        return Response.json(
          {
            profileId,
            calls,
            responseCharacters: bytes,
            wallMs: performance.now() - started,
            last: JSON.parse(last),
          },
          { headers: { "cache-control": "no-store" } },
        );
      }
      const requestId =
          url.searchParams.get("requestId") ?? crypto.randomUUID(),
        started = performance.now();
      try {
        const preferred = url.pathname.split("/").at(-1);
        if (
          preferred !== "complete-terms" &&
          preferred !== "documents" &&
          preferred !== "documents-single-anchor"
        )
          throw Error("Unknown benchmark plan");
        const input: any = await request.json(),
          ast = parse(input.q, input.mode);
        if (input.resetMemory) {
          memory.clear();
          directory.clear();
        }
        const terms = await directory.lookup(queryTerms(ast)),
          namespace =
            input.cacheNamespace ?? env.CACHE_NAMESPACE ?? "packet-benchmark",
          shared: SharedPages = {
            async get(key) {
              const r = await (caches as any).default.match(
                `${url.origin}/__packet_benchmark/${key}`,
              );
              return r?.headers.get("x-cws-validated") === key
                ? new Uint8Array(await r.arrayBuffer())
                : undefined;
            },
            async put(key, bytes) {
              await (caches as any).default.put(
                `${url.origin}/__packet_benchmark/${key}`,
                new Response(bytes as BodyInit, {
                  headers: {
                    "cache-control": "public,max-age=31536000,immutable",
                    "x-cws-validated": key,
                  },
                }),
              );
            },
          },
          reader = new Reader(
            root,
            new ColumnarR2(env.INDEX),
            memory,
            shared,
            namespace,
            (p) => ctx.waitUntil(p),
          ),
          packages = {
            averageBytes: root.documentPackages!.averageBytes,
            load: (doc: number) =>
              reader.document(
                root.documentPackages!.generation,
                doc,
                documents?.lookup(doc),
              ),
          };
        let chosen: "complete-terms" | "documents" | PacketPlan =
          preferred === "documents-single-anchor" ? "documents" : preferred;
        if (preferred === "documents-single-anchor") {
          const plan = packetPlan(
            simplify(ast, (name) => terms.has(name)),
            terms,
            root,
            input,
            packages,
            "documents",
          );
          if (plan.kind !== "documents")
            return Response.json(
              { unsupported: true, preferred },
              { status: 422 },
            );
          const term = terms.get(plan.anchor!)!,
            bytes = [term.frequencies, ...(term.frequencyParts ?? [])].reduce(
              (n, r) => n + r[2],
              0,
            );
          if (bytes > 1048576)
            return Response.json(
              { unsupported: true, preferred },
              { status: 422 },
            );
          chosen = {
            ...plan,
            anchors: [plan.anchor!],
            expectedCandidates: term.df,
            expectedDocumentBytes: term.df * packages.averageBytes,
            frequencyBytes: bytes,
          };
        }
        const result = await executePackets(
          simplify(ast, (name) => terms.has(name)),
          terms,
          root,
          reader,
          input,
          packages,
          chosen,
        );
        if (!result)
          return Response.json(
            { unsupported: true, preferred },
            { status: 422 },
          );
        const telemetry = {
          requestId,
          isolate,
          wallMs: performance.now() - started,
        };
        console.log(JSON.stringify({ benchmark: telemetry }));
        return Response.json(
          { ...result, telemetry, colo: (request as any).cf?.colo },
          { headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        return Response.json(
          { error: String(error), requestId, isolate },
          { status: 500 },
        );
      }
    },
  };
}
