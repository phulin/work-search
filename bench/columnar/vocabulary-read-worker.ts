import { BuildStore } from "../../src/columnar/construction/runs.js";
import {
  CorpusSource,
  type SourceRoot,
} from "../../src/columnar/construction/source.js";
import {
  buildVocabulary,
  readVocabulary,
} from "../../src/columnar/construction/vocabulary.js";
import {
  ConstructionWordLookup,
  type ConstructionWords,
} from "../../src/columnar/construction/word-lookup.js";
import { finishDocumentGroup } from "../../src/columnar/construction/document-groups.js";
import { countedBucket } from "../../src/columnar/construction/bucket.js";
export function vocabularyReadPilot(
  sourceRoot: SourceRoot,
  words: ConstructionWords,
) {
  let active = false;
  return {
    async fetch(
      request: Request,
      env: { INDEX: R2Bucket; INTERNAL_TOKEN: string },
    ) {
      if (
        request.headers.get("authorization") !== `Bearer ${env.INTERNAL_TOKEN}`
      )
        return new Response("Not found", { status: 404 });
      if (new URL(request.url).pathname === "/health")
        return Response.json({
          root: words.rootSha256,
          commonTerms: words.ids.length,
          packets: words.packets.length,
        });
      if (active) return new Response("Busy", { status: 503 });
      active = true;
      try {
        const input = (await request.json()) as any,
          path = new URL(request.url).pathname,
          counted = countedBucket(env.INDEX),
          store = new BuildStore(counted.bucket),
          source = new CorpusSource(counted.bucket, sourceRoot),
          started = performance.now(),
          root = JSON.parse(
            new TextDecoder().decode(await store.get(input.rootRef)),
          );
        if (
          input.rootRef.sha256 !== words.rootSha256 ||
          root.generation !== words.generation
        )
          throw Error("Pilot corpus mismatch");
        // Deliberately no retained packet/word cache across measured calls.
        const lookup = new ConstructionWordLookup(words).request(store);
        let output;
        if (path === "/control" || path === "/compact")
          output = await buildVocabulary(
            source,
            store,
            root,
            input.first,
            input.count,
            path === "/compact" ? lookup : undefined,
          );
        else if (path === "/seeded" || path === "/fused")
          output = await finishDocumentGroup(
            source,
            store,
            root,
            path === "/seeded"
              ? await readVocabulary(store, input.vocabularyRef)
              : undefined,
            root.generation,
            input.first,
            input.count,
            undefined,
            undefined,
            path === "/fused" ? lookup : undefined,
          );
        else return new Response("Not found", { status: 404 });
        return Response.json({
          output,
          wallMs: performance.now() - started,
          r2: counted.operations,
          sourceRequests: source.requests,
          sourceBytes: source.bytes,
        });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      } finally {
        active = false;
      }
    },
  };
}
