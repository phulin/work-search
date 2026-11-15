import { concat, pack } from "../format.js";
import { finishPackageDocuments } from "./package-documents.js";
import { documentPrefix } from "../document-package.js";
import { digest, jsonBytes, BuildStore } from "./runs.js";
import { readVocabulary } from "./vocabulary.js";
import { CorpusSource, type SourceRoot } from "./source.js";
import { countedBucket } from "./bucket.js";
import {
  ConstructionWordLookup,
  type ConstructionWords,
} from "./word-lookup.js";
import { ENGLISH_ANALYSIS } from "../../query/analysis.js";

export async function finishDocumentGroup(
  ...args: Parameters<typeof finishPackageDocuments>
) {
  if (args[6] > 1024)
    throw Error("Document groups contain at most 1024 documents");
  const packets: Uint8Array[] = [],
    offsets = [0],
    prefixes: number[] = [],
    budgets: number[] = [];
  const result = await finishPackageDocuments(
      ...(args.slice(0, 7) as [any, any, any, any, any, any, any]),
      async (_doc, packet) => {
        if (packets.length && offsets.at(-1)! + packet.length > 16 * 1048576)
          return false;
        packets.push(packet);
        offsets.push(offsets.at(-1)! + packet.length);
        prefixes.push(documentPrefix(packet));
        budgets.push(
          new DataView(
            packet.buffer,
            packet.byteOffset,
            packet.byteLength,
          ).getUint32(16, true),
        );
      },
      4 * 1048576,
      args[9],
      args[10],
    ),
    store = args[1],
    data = concat(packets),
    sha256 = await digest(data),
    key = `${sha256}/plan-0.bin`;
  store.requests++;
  store.bytes += data.length;
  await store.bucket.put(key, data as ArrayBufferView<ArrayBuffer>, {
    sha256,
    customMetadata: {
      generation: sha256,
      sha256,
      packageFirst: String(result.first),
      packageEnd: String(result.end),
    },
  });
  return {
    ...result,
    group: {
      first: result.first,
      end: result.end,
      sha256,
      offsets: btoa(String.fromCharCode(...pack(offsets, true))),
      prefixes: btoa(String.fromCharCode(...pack(prefixes))),
      verificationBytes: btoa(String.fromCharCode(...pack(budgets))),
    },
  };
}
/** A separate handler lets a running constructor add grouped transport without
 * changing the frozen core that owns its already acknowledged sorting jobs. */
export function createDocumentGroupHandler(
  root: SourceRoot,
  code: string,
  bundled?: ConstructionWords,
) {
  let words: ConstructionWordLookup | undefined;
  let pending = 0,
    tail = Promise.resolve(),
    isolate: string | undefined;
  return {
    async fetch(
      request: Request,
      env: { INDEX: R2Bucket; INTERNAL_TOKEN: string },
    ) {
      if (
        request.headers.get("authorization") !== `Bearer ${env.INTERNAL_TOKEN}`
      )
        return new Response("Not found", { status: 404 });
      const path = new URL(request.url).pathname;
      if (path === "/group-health")
        return Response.json({
          code,
          format: "grouped-CDP4",
          directWordLookup: bundled?.rootSha256,
        });
      if (path !== "/grouped-documents" || request.method !== "POST")
        return new Response("Not found", { status: 404 });
      if (pending >= 4)
        return new Response("Construction capacity busy", { status: 503 });
      const previous = tail,
        queued = performance.now();
      let release!: () => void;
      tail = new Promise<void>((r) => (release = r));
      pending++;
      await previous;
      const counted = countedBucket(env.INDEX);
      env = { ...env, INDEX: counted.bucket };
      const started = performance.now();
      isolate ??= crypto.randomUUID();
      try {
        const input = (await request.json()) as any;
        if (
          typeof input.build !== "string" ||
          typeof input.task !== "string" ||
          !/^[a-z0-9-]{1,80}$/.test(input.build) ||
          !/^[a-z0-9-]{1,80}$/.test(input.task)
        )
          throw Error("Invalid construction task");
        const key = `cws-build/${input.build}/${input.task}.json`,
          fingerprint = await digest(
            jsonBytes({ code, operation: path, input }),
          ),
          old = await env.INDEX.get(key);
        if (old) {
          const saved = await old.json<any>();
          if (saved.fingerprint !== fingerprint)
            throw Error("Construction task changed");
          return Response.json({
            ...saved.result,
            writesAndMergeReads: 0,
            writeAndMergeBytes: 0,
            originalWork: saved.result.telemetry,
            telemetry: {
              isolate,
              code,
              build: input.build,
              task: input.task,
              wallMs: performance.now() - started,
              queueMs: started - queued,
              requests: 0,
              bytes: 0,
              r2: counted.operations,
              io: counted.snapshot(),
              reused: true,
            },
            reused: true,
          });
        }
        const direct =
            bundled?.rootSha256 === input.rootRef?.sha256 ? bundled : undefined,
          store = new BuildStore(env.INDEX),
          source = new CorpusSource(env.INDEX, root),
          idsRoot = direct
            ? {
                generation: direct.generation,
                count: direct.count,
                analysis: ENGLISH_ANALYSIS,
                objects: [],
                idRouting: { dictionaries: [] },
              }
            : JSON.parse(
                new TextDecoder().decode(await store.get(input.rootRef)),
              ),
          vocabulary = input.vocabularyRef
            ? await readVocabulary(store, input.vocabularyRef)
            : undefined,
          output = await finishDocumentGroup(
            source,
            store,
            idsRoot,
            vocabulary,
            input.generation,
            input.first,
            input.count,
            undefined,
            undefined,
            direct
              ? (words ??= new ConstructionWordLookup(direct)).request(store)
              : undefined,
          ),
          telemetry = {
            isolate,
            code,
            build: input.build,
            task: input.task,
            operation: path,
            wallMs: performance.now() - started,
            queueMs: started - queued,
            requests: source.requests,
            bytes: source.bytes,
            r2: counted.operations,
            io: counted.snapshot(),
          },
          result = {
            output,
            writesAndMergeReads: store.requests,
            writeAndMergeBytes: store.bytes,
            telemetry,
          };
        await env.INDEX.put(
          key,
          jsonBytes({ fingerprint, result }) as ArrayBufferView<ArrayBuffer>,
        );
        console.log(JSON.stringify({ construction: telemetry }));
        return Response.json(result);
      } catch (error) {
        const telemetry = {
          isolate,
          code,
          operation: path,
          wallMs: performance.now() - started,
          queueMs: started - queued,
          r2: counted.operations,
          io: counted.snapshot(),
          failed: true,
        };
        console.log(
          JSON.stringify({ construction: telemetry, error: String(error) }),
        );
        return Response.json(
          { error: String(error), telemetry },
          { status: 400 },
        );
      } finally {
        pending--;
        release();
      }
    },
  };
}
