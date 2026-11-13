import { CorpusSource, type SourceRoot } from "./source.js";
import { tokenize } from "../../query/tokenize.js";
import {
  BuildStore,
  ingest,
  merge,
  digest,
  jsonBytes,
  generationFor,
} from "./runs.js";
import { finishPostings } from "./finish.js";
import { finishDocuments } from "./documents.js";
import { Lru } from "../storage.js";
export function createConstructionWorker(root: SourceRoot, code: string) {
  let isolate: string | undefined,
    active = 0,
    idCacheGeneration: string | undefined;
  const idCache = new Lru<number>(8 * 1048576);
  return {
    async fetch(
      request: Request,
      env: { INDEX: R2Bucket; INTERNAL_TOKEN: string },
    ) {
      isolate ??= crypto.randomUUID();
      const url = new URL(request.url);
      if (
        request.headers.get("authorization") !== `Bearer ${env.INTERNAL_TOKEN}`
      )
        return new Response("Not found", { status: 404 });
      if (url.pathname === "/health")
        return Response.json({
          code,
          sourceDocuments: root.documents,
          sourceHash: await digest(jsonBytes(root)),
          isolate,
        });
      if (request.method !== "POST")
        return new Response("Method not allowed", { status: 405 });
      if (active)
        return new Response("Construction capacity busy", {
          status: 503,
          headers: { "retry-after": "1" },
        });
      active++;
      const started = performance.now(),
        source = new CorpusSource(env.INDEX, root);
      try {
        const input = (await request.json()) as any;
        let result;
        if (url.pathname === "/probe") {
          const part = root.parts.find((p) => p.part === input.part);
          if (!part) throw Error("Unknown source partition");
          const map = await source.get(part.generation, "contentmap-0.bin"),
            view = new DataView(
              map.bytes.buffer,
              map.bytes.byteOffset,
              map.bytes.byteLength,
            ),
            largest: { doc: number; compressedBytes: number }[] = [];
          if (map.bytes.length !== part.count * 32)
            throw Error("Source map size mismatch");
          for (let row = 0; row < part.count; row++) {
            largest.push({
              doc: part.first + row,
              compressedBytes: view.getUint32(row * 32 + 8, true),
            });
            largest.sort(
              (a, b) => b.compressedBytes - a.compressedBytes || a.doc - b.doc,
            );
            if (largest.length > 8) largest.pop();
          }
          result = {
            part: part.part,
            generation: part.generation,
            count: part.count,
            mapSha256: map.sha256,
            largest,
          };
        } else if (url.pathname === "/sample" || url.pathname === "/source") {
          const first = Number(input.first ?? 0),
            count = Number(input.count ?? 1);
          if (
            !Number.isInteger(count) ||
            count < 1 ||
            count > (url.pathname === "/source" ? 128 : 16)
          )
            throw Error("Invalid sample size");
          const pointers = await source.pointers(first, count),
            rows = [];
          if (url.pathname === "/source") await source.prefetch(pointers);
          let characters = 0;
          for (let row = 0; row < count; row++) {
            const d = await source.document(first + row, pointers, row);
            rows.push(
              url.pathname === "/source"
                ? d
                : {
                    id: d.id,
                    title: d.title,
                    metadata: d.metadata,
                    doc: d.doc,
                    bodyCharacters: d.body.length,
                    bodyTokens: tokenize(d.body).length,
                    titleTokens: tokenize(d.title ?? "").length,
                    preview: d.body.slice(0, 240),
                  },
            );
            characters += d.body.length;
            if (url.pathname === "/source" && characters >= 2000000) break;
          }
          result = {
            first,
            count: rows.length,
            next: first + rows.length,
            rows,
          };
        } else if (
          [
            "/ingest",
            "/merge",
            "/postings",
            "/documents",
            "/publish",
            "/stage",
          ].includes(url.pathname)
        ) {
          if (
            typeof input.build !== "string" ||
            typeof input.task !== "string" ||
            !/^[a-z0-9-]{1,80}$/.test(input.build) ||
            !/^[a-z0-9-]{1,80}$/.test(input.task)
          )
            throw Error("Invalid construction task");
          const key = `cws-build/${input.build}/${input.task}.json`,
            fingerprint = await digest(
              jsonBytes({ code, operation: url.pathname, input }),
            ),
            existing = await env.INDEX.get(key);
          if (existing) {
            const saved = await existing.json<any>();
            if (saved.fingerprint !== fingerprint)
              throw Error("Construction task changed; use another task name");
            result = { ...saved.result, reused: true };
          } else {
            const store = new BuildStore(env.INDEX);
            if (input.stateTask) {
              if (!/^[a-z0-9-]{1,80}$/.test(input.stateTask))
                throw Error("Invalid previous task");
              const previous = await env.INDEX.get(
                `cws-build/${input.build}/${input.stateTask}.json`,
              );
              if (!previous) throw Error("Missing previous task");
              input.state = (await previous.json<any>()).result.output.state;
            }
            if (input.rootRef)
              input.root = JSON.parse(
                new TextDecoder().decode(await store.get(input.rootRef)),
              );
            if (
              input.tokenBudget !== undefined &&
              (!Number.isInteger(input.tokenBudget) ||
                input.tokenBudget < 1 ||
                input.tokenBudget > 1048576)
            )
              throw Error("Invalid token budget");
            if (
              input.byteBudget !== undefined &&
              (!Number.isInteger(input.byteBudget) ||
                input.byteBudget < 1 ||
                input.byteBudget > 8 * 1048576)
            )
              throw Error("Invalid byte budget");
            const publish = async () => {
              // The constructor checks generation and document-table coverage.
              const { ColumnarIndex } = await import("../search.js");
              new ColumnarIndex(input.root);
              if ((await generationFor(input.root)) !== input.root.generation)
                throw Error("Generation does not identify the complete layout");
              for (const descriptor of input.root.objects) {
                if (
                  !descriptor.key ||
                  !/^[a-f0-9]{64}\/plan-0\.bin$/.test(descriptor.key)
                )
                  throw Error("Invalid built object key");
                const object = await env.INDEX.head(descriptor.key);
                if (
                  !object ||
                  object.size !== descriptor.size ||
                  object.customMetadata?.sha256 !== descriptor.sha256
                )
                  throw Error("Incomplete built object");
              }
              await env.INDEX.put(
                `${input.root.generation}/root.json`,
                jsonBytes(input.root) as ArrayBufferView<ArrayBuffer>,
                { customMetadata: { generation: input.root.generation, code } },
              );
              return { generation: input.root.generation };
            };
            if (
              url.pathname === "/documents" &&
              idCacheGeneration !== input.root.generation
            ) {
              idCache.clear();
              idCacheGeneration = input.root.generation;
            }
            const output =
              url.pathname === "/stage"
                ? await store.put(jsonBytes(input.value))
                : url.pathname === "/ingest"
                  ? await ingest(source, store, input.first, input.count)
                  : url.pathname === "/merge"
                    ? await merge(store, input.runs, input.state)
                    : url.pathname === "/postings"
                      ? await finishPostings(
                          store,
                          input.run,
                          input.statistics,
                          input.objectBase,
                          input.state,
                          input.byteBudget,
                        )
                      : url.pathname === "/publish"
                        ? await publish()
                        : await finishDocuments(
                            source,
                            store,
                            input.root,
                            input.objectBase,
                            input.state,
                            input.tokenBudget ?? 1048576,
                            idCache,
                          );
            result = {
              output,
              writesAndMergeReads: store.requests,
              writeAndMergeBytes: store.bytes,
            };
            await env.INDEX.put(
              key,
              jsonBytes({
                fingerprint,
                result,
              }) as ArrayBufferView<ArrayBuffer>,
            );
          }
          if (
            input.compact &&
            ["/documents", "/postings"].includes(url.pathname)
          ) {
            const output = result.output,
              state = output.state;
            result = {
              ...result,
              output: {
                ...output,
                state:
                  url.pathname === "/documents"
                    ? {
                        next: state.next,
                        documents: output.done ? state.documents : undefined,
                      }
                    : {
                        nextTerm: state.nextTerm,
                        done: state.done,
                        hot: state.done ? state.hot : undefined,
                        ids: state.done ? state.ids : undefined,
                        dictionaries: state.done
                          ? state.dictionaries
                          : undefined,
                      },
              },
            };
          }
        } else return new Response("Not found", { status: 404 });
        const telemetry = {
          isolate,
          code,
          wallMs: performance.now() - started,
          requests: source.requests,
          bytes: source.bytes,
        };
        console.log(JSON.stringify({ construction: telemetry }));
        return Response.json(
          { ...result, telemetry },
          { headers: { "cache-control": "no-store" } },
        );
      } catch (e) {
        return Response.json(
          {
            error: String(e),
            isolate,
            code,
            wallMs: performance.now() - started,
          },
          { status: 500 },
        );
      } finally {
        active--;
      }
    },
  };
}
