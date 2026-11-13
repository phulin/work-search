import {
  BuildStore,
  digest,
  jsonBytes,
} from "../../src/columnar/construction/runs.js";
import {
  CorpusSource,
  type SourceRoot,
} from "../../src/columnar/construction/source.js";
import { buildVocabulary } from "../../src/columnar/construction/vocabulary.js";
import { WordDirectory } from "../../src/columnar/word-directory.js";
/** Temporary route for measuring a new constructor without replacing active jobs. */
export function createVocabularyWorker(
  sourceRoot: SourceRoot,
  code: string,
  bundled?: {
    data: Uint8Array;
    generation: string;
    count: number;
    rootSha256: string;
  },
) {
  const route = bundled ? "/vocabulary-bundled" : "/vocabulary-once";
  let words: WordDirectory | undefined;
  let isolate: string | undefined;
  return {
    async fetch(
      request: Request,
      env: { INDEX: R2Bucket; INTERNAL_TOKEN: string },
    ) {
      if (
        request.headers.get("authorization") !== `Bearer ${env.INTERNAL_TOKEN}`
      )
        return new Response("Not found", { status: 404 });
      isolate ??= crypto.randomUUID();
      if (new URL(request.url).pathname === route + "-health")
        return Response.json({
          code,
          isolate,
          bundledBytes: bundled?.data.length,
        });
      const input = (await request.json()) as any;
      if (
        !/^[a-z0-9-]{1,80}$/.test(input.build) ||
        !/^[a-z0-9-]{1,70}$/.test(input.task)
      )
        throw Error("Invalid vocabulary task");
      if (bundled && input.rootRef.sha256 !== bundled.rootSha256)
        throw Error("Bundled vocabulary source mismatch");
      const key = `cws-build/${input.build}/${route.slice(1)}-${input.task}.json`,
        fingerprint = await digest(jsonBytes({ code, input })),
        old = await env.INDEX.get(key);
      if (old) {
        const value = await old.json<any>();
        if (value.fingerprint !== fingerprint)
          throw Error("Changed vocabulary task");
        return Response.json({ ...value.result, reused: true });
      }
      const store = new BuildStore(env.INDEX),
        source = new CorpusSource(env.INDEX, sourceRoot),
        started = performance.now(),
        root = bundled
          ? {
              generation: bundled.generation,
              count: bundled.count,
              objects: [],
              objectIds: [],
              idRouting: { dictionaries: [] },
            }
          : JSON.parse(
              new TextDecoder().decode(await store.get(input.rootRef)),
            ),
        output = await buildVocabulary(
          source,
          store,
          root,
          input.first,
          input.count,
          bundled
            ? {
                generation: bundled.generation,
                lookup: (names) =>
                  (words ??= new WordDirectory(bundled.data)).lookup(names),
              }
            : undefined,
        ),
        result = {
          output,
          writesAndMergeReads: store.requests,
          writeAndMergeBytes: store.bytes,
          telemetry: {
            code,
            isolate,
            build: input.build,
            task: input.task,
            operation: route,
            wallMs: performance.now() - started,
            requests: source.requests,
            bytes: source.bytes,
          },
        };
      await env.INDEX.put(
        key,
        jsonBytes({ fingerprint, result }) as ArrayBufferView<ArrayBuffer>,
      );
      return Response.json(result);
    },
  };
}
