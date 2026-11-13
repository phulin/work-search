import { concat, pack, u32 } from "../format.js";
import { crc32 } from "../../format/codec.js";
import { finishPackageDocuments } from "./package-documents.js";
import { digest, jsonBytes, BuildStore } from "./runs.js";
import { readVocabulary } from "./vocabulary.js";
import { CorpusSource, type SourceRoot } from "./source.js";

export async function finishDocumentGroup(
  ...args: Parameters<typeof finishPackageDocuments>
) {
  if (args[6] > 128)
    throw Error("Document groups contain at most 128 documents");
  const packets: Uint8Array[] = [],
    offsets = [0],
    crcs: number[] = [];
  const result = await finishPackageDocuments(
      ...(args.slice(0, 7) as [any, any, any, any, any, any, any]),
      async (_doc, packet) => {
        packets.push(packet);
        offsets.push(offsets.at(-1)! + packet.length);
        crcs.push(crc32(packet));
      },
    ),
    store = args[1],
    data = concat(packets),
    sha256 = await digest(data),
    key = `${sha256}/plan-0.bin`;
  const crcBytes = u32(crcs),
    encoded = btoa(String.fromCharCode(...crcBytes));
  store.requests++;
  store.bytes += data.length;
  await store.bucket.put(key, data as ArrayBufferView<ArrayBuffer>, {
    sha256,
    customMetadata: {
      generation: sha256,
      sha256,
      packageFirst: String(result.first),
      packageEnd: String(result.end),
      packageCrc32: encoded,
    },
  });
  return {
    ...result,
    group: {
      first: result.first,
      end: result.end,
      sha256,
      offsets: btoa(String.fromCharCode(...pack(offsets, true))),
    },
  };
}
/** A separate handler lets a running constructor add grouped transport without
 * changing the frozen core that owns its already acknowledged sorting jobs. */
export function createDocumentGroupHandler(root: SourceRoot, code: string) {
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
        return Response.json({ code, format: "grouped-CDP2" });
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
          return Response.json({ ...saved.result, reused: true });
        }
        const store = new BuildStore(env.INDEX),
          source = new CorpusSource(env.INDEX, root),
          idsRoot = JSON.parse(
            new TextDecoder().decode(await store.get(input.rootRef)),
          ),
          vocabulary = await readVocabulary(store, input.vocabularyRef),
          output = await finishDocumentGroup(
            source,
            store,
            idsRoot,
            vocabulary,
            input.generation,
            input.first,
            input.count,
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
        return Response.json({ error: String(error) }, { status: 400 });
      } finally {
        pending--;
        release();
      }
    },
  };
}
