import { openIndex } from "../src/format/paged.js";
import { R2Storage } from "../src/storage/r2.js";
import { SearchRuntime } from "../src/query/runtime.js";
import { search } from "../src/query/engine.js";
import { parallel } from "../src/storage/types.js";
import { parse, queryTerms } from "../src/query/parser.js";
export function createShard(
  binary: Uint8Array,
  runtime = new SearchRuntime(4 * 1048576),
  onDiagnostics?: (value: unknown) => void,
) {
  const index = openIndex(binary);
  return {
    async fetch(
      request: Request,
      env: { INDEX: R2Bucket; INTERNAL_TOKEN: string; SHARD_ID: string },
    ) {
      if (
        !env.INTERNAL_TOKEN ||
        request.headers.get("authorization") !== `Bearer ${env.INTERNAL_TOKEN}`
      )
        return new Response("Not found", { status: 404 });
      try {
        const url = new URL(request.url),
          storage = new R2Storage(env.INDEX, index.generation),
          body: any = await request.json();
        if (url.pathname === "/internal/stats") {
          const terms = queryTerms(parse(body.q)),
            view = index.queryIndex();
          await view.prepareTerms(terms, storage, runtime);
          return Response.json({
            apiVersion: 2,
            count: index.count,
            bodyTokens: Math.round(index.avgBody * index.count),
            titleTokens: Math.round(index.avgTitle * index.count),
            generations: { [env.SHARD_ID]: index.generation },
            df: Object.fromEntries(
              terms.map((t) => [t, view.lookup(t)?.df ?? 0]),
            ),
          });
        }
        if (body.generations?.[env.SHARD_ID] !== index.generation)
          return Response.json(
            { error: "Generation changed; retry query" },
            { status: 409 },
          );
        if (url.pathname === "/internal/search") {
          const result = await search(index, storage, body.q, {
            limit: body.limit,
            globalStats: body.globalStats,
            internalDoc: true,
            after: body.after
              ? {
                  score: body.after.score,
                  doc:
                    Number(env.SHARD_ID) < body.after.shard
                      ? 0xffffffff
                      : Number(env.SHARD_ID) === body.after.shard
                        ? body.after.doc
                        : -1,
                }
              : undefined,
            runtime,
          });
          onDiagnostics?.(result.diagnostics);
          return Response.json({
            results: result.results.map((h) => ({
              ...h,
              shard: Number(env.SHARD_ID),
            })),
          });
        }
        if (url.pathname === "/internal/documents") {
          const view = index.queryIndex();
          await view.prepareTerms([], storage, runtime);
          const docs =
            body.docs ??
            body.hits
              .filter((h: any) => h.shard === Number(env.SHARD_ID))
              .map((h: any) => h.doc);
          await view.resolveDocuments(docs, storage, true);
          const results = await parallel(docs as number[], 4, async (doc) => {
            const d = view.document(doc),
              m = JSON.parse(
                new TextDecoder().decode(
                  await storage.read(
                    view.key(d.metaObject, "metadata"),
                    d.metaOffset,
                    d.metaLength,
                  ),
                ),
              );
            if (m.id !== d.id) throw Error("Metadata mismatch");
            return { doc, shard: Number(env.SHARD_ID), ...m };
          });
          return Response.json({ results });
        }
        return new Response("Not found", { status: 404 });
      } catch (e) {
        console.error(e);
        return Response.json(
          { error: e instanceof Error ? e.message : "Shard search failed" },
          { status: 503 },
        );
      }
    },
  };
}
