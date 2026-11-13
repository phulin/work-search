import { CorpusSource, type SourceRoot } from "./source.js";
import { tokenize } from "../../query/tokenize.js";
import {
  BuildStore,
  ingest,
  merge,
  digest,
  jsonBytes,
  generationFor,
  VERIFY_OBJECTS,
} from "./runs.js";
import { finishPostings, combineRouting } from "./finish.js";
import { finishDocuments } from "./documents.js";
import { finishPackageDocuments } from "./package-documents.js";
import { createDocumentGroupHandler } from "./document-groups.js";
import { finishPacketTerms } from "./packet-terms.js";
import { buildVocabulary, readVocabulary } from "./vocabulary.js";
export function createConstructionWorker(root: SourceRoot, code: string) {
  const groups = createDocumentGroupHandler(root, code);
  let isolate: string | undefined,
    pending = 0,
    tail = Promise.resolve();
  return {
    async fetch(
      request: Request,
      env: { INDEX: R2Bucket; INTERNAL_TOKEN: string },
    ) {
      isolate ??= crypto.randomUUID();
      const url = new URL(request.url);
      if (
        url.pathname === "/group-health" ||
        url.pathname === "/grouped-documents"
      )
        return groups.fetch(request, env);
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
          placement: request.headers.get("cf-placement"),
        });
      if (request.method !== "POST")
        return new Response("Method not allowed", { status: 405 });
      if (pending >= 4)
        return new Response("Construction capacity busy", {
          status: 503,
          headers: { "retry-after": "1" },
        });
      // Requests may share an isolate. Queue before parsing their bodies so
      // concurrent invocations cannot multiply construction buffers. Separate
      // isolates still execute independently under the same deployment.
      const queuedAt = performance.now(),
        previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      pending++;
      await previous;
      const started = performance.now(),
        source = new CorpusSource(env.INDEX, root);
      try {
        const input = (await request.json()) as any;
        let result;
        if (url.pathname === "/probe-io") {
          const samples = [];
          for (let i = 0; i < 10; i++) {
            const started = performance.now();
            await source.get(
              root.parts[0].generation,
              "contentmap-0.bin",
              0,
              262144,
            );
            samples.push(performance.now() - started);
          }
          const trace = await fetch(
            "https://www.cloudflare.com/cdn-cgi/trace",
          ).then((r) => r.text());
          result = {
            samples,
            egressColo: /^colo=(.+)$/m.exec(trace)?.[1],
            placement: request.headers.get("cf-placement"),
          };
        } else if (url.pathname === "/probe") {
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
            "/package-documents",
            "/packet-terms",
            "/vocabulary",
            "/publish",
            "/verify",
            "/stage",
            "/routing",
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
            if (input.runRef)
              input.run = JSON.parse(
                new TextDecoder().decode(await store.get(input.runRef)),
              );
            if (input.runsRef)
              input.runs = JSON.parse(
                new TextDecoder().decode(await store.get(input.runsRef)),
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
                input.byteBudget > 32 * 1048576)
            )
              throw Error("Invalid byte budget");
            const validateRoot = async () => {
              // The constructor checks generation and document-table coverage.
              const { ColumnarIndex } = await import("../search.js");
              new ColumnarIndex(input.root);
              if ((await generationFor(input.root)) !== input.root.generation)
                throw Error("Generation does not identify the complete layout");
            };
            const verifyRange = async () => {
              await validateRoot();
              const first = Number(input.first),
                descriptors = input.root.objects.slice(
                  first,
                  first + VERIFY_OBJECTS,
                );
              if (
                !Number.isInteger(first) ||
                first < 0 ||
                first % VERIFY_OBJECTS ||
                !descriptors.length
              )
                throw Error("Invalid publication verification range");
              const verify = async (descriptor: any) => {
                if (
                  !descriptor.key ||
                  !/^[a-f0-9]{64}\/plan-0\.bin$/.test(descriptor.key)
                )
                  throw Error("Invalid built object key");
                store.requests++;
                const object = await env.INDEX.head(descriptor.key);
                if (
                  !object ||
                  object.size !== descriptor.size ||
                  object.customMetadata?.sha256 !== descriptor.sha256
                )
                  throw Error("Incomplete built object");
              };
              for (let i = 0; i < descriptors.length; i += 4)
                await Promise.all(descriptors.slice(i, i + 4).map(verify));
              return {
                first,
                count: descriptors.length,
                generation: input.root.generation,
                sha256: await digest(jsonBytes(descriptors)),
              };
            };
            const publish = async () => {
              await validateRoot();
              if (input.root.documentPackages) {
                let next = 0,
                  bytes = 0;
                if (!Array.isArray(input.packageVerifications))
                  throw Error("Publication requires document package coverage");
                for (const task of input.packageVerifications) {
                  if (!/^[a-z0-9-]{1,80}$/.test(task))
                    throw Error("Invalid package verification");
                  const object = await env.INDEX.get(
                    `cws-build/${input.build}/${task}.json`,
                  );
                  if (!object) throw Error("Missing document package receipt");
                  const receipt = (await object.json<any>()).result.output;
                  if (
                    receipt.generation !==
                      input.root.documentPackages.generation ||
                    receipt.first !== next ||
                    receipt.end <= next ||
                    receipt.documents !== receipt.end - next
                  )
                    throw Error("Document package coverage mismatch");
                  next = receipt.end;
                  bytes += receipt.bytes;
                }
                if (
                  next !== input.root.count ||
                  bytes !== input.root.documentPackages.bytes
                )
                  throw Error("Incomplete document package coverage");
              }
              const tasks = input.verifications as string[];
              if (
                !Array.isArray(tasks) ||
                tasks.length !==
                  Math.ceil(input.root.objects.length / VERIFY_OBJECTS)
              )
                throw Error(
                  "Publication requires complete object verification",
                );
              for (let at = 0; at < tasks.length; at += 4)
                await Promise.all(
                  tasks.slice(at, at + 4).map(async (task, i) => {
                    if (!/^[a-z0-9-]{1,80}$/.test(task))
                      throw Error("Invalid verification task");
                    store.requests++;
                    const object = await env.INDEX.get(
                      `cws-build/${input.build}/${task}.json`,
                    );
                    if (!object)
                      throw Error("Missing publication verification");
                    store.bytes += object.size;
                    const receipt = (await object.json<any>()).result.output,
                      first = (at + i) * VERIFY_OBJECTS,
                      descriptors = input.root.objects.slice(
                        first,
                        first + VERIFY_OBJECTS,
                      );
                    if (
                      receipt.first !== first ||
                      receipt.count !== descriptors.length ||
                      receipt.generation !== input.root.generation ||
                      receipt.sha256 !== (await digest(jsonBytes(descriptors)))
                    )
                      throw Error("Publication verification coverage mismatch");
                  }),
                );
              await env.INDEX.put(
                `${input.root.generation}/root.json`,
                jsonBytes(input.root) as ArrayBufferView<ArrayBuffer>,
                { customMetadata: { generation: input.root.generation, code } },
              );
              return { generation: input.root.generation };
            };
            const output =
              url.pathname === "/stage"
                ? await store.put(jsonBytes(input.value))
                : url.pathname === "/routing"
                  ? await combineRouting(store, input.parts, input.objectBase)
                  : url.pathname === "/ingest"
                    ? await ingest(source, store, input.first, input.count)
                    : url.pathname === "/merge"
                      ? await merge(
                          store,
                          input.runs,
                          input.state,
                          128 * 1048576,
                          input.range,
                        )
                      : url.pathname === "/postings"
                        ? await finishPostings(
                            store,
                            input.run,
                            input.statistics,
                            input.objectBase,
                            input.state,
                            input.byteBudget,
                            input.range,
                          )
                        : url.pathname === "/verify"
                          ? await verifyRange()
                          : url.pathname === "/publish"
                            ? await publish()
                            : url.pathname === "/packet-terms"
                              ? await finishPacketTerms(
                                  store,
                                  input.root,
                                  input.fences,
                                  input.objectBase,
                                  input.state,
                                  input.byteBudget,
                                )
                              : url.pathname === "/package-documents"
                                ? await finishPackageDocuments(
                                    source,
                                    store,
                                    input.root,
                                    await readVocabulary(
                                      store,
                                      input.vocabularyRef,
                                    ),
                                    input.generation,
                                    input.first,
                                    input.count,
                                  )
                                : url.pathname === "/vocabulary"
                                  ? await buildVocabulary(
                                      source,
                                      store,
                                      input.root,
                                      input.first,
                                      input.count,
                                    )
                                  : await finishDocuments(
                                      source,
                                      store,
                                      input.documentRoot,
                                      await readVocabulary(
                                        store,
                                        input.vocabularyRef,
                                      ),
                                      input.objectBase,
                                      input.state,
                                      input.tokenBudget ?? 1048576,
                                      input.range,
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
          build: input.build,
          task: input.task,
          operation: url.pathname,
          placement: request.headers.get("cf-placement"),
          wallMs: performance.now() - started,
          queueMs: started - queuedAt,
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
        pending--;
        release();
      }
    },
  };
}
