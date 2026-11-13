import {
  BuildStore,
  digest,
  jsonBytes,
} from "../../src/columnar/construction/runs.js";
import { pairRangeJob } from "../../src/columnar/construction/pair-range-jobs.js";
/** Temporary adapter preserving the handlers of builds already in progress. */
export function createPairRangeWorker(code: string) {
  let isolate: string | undefined;
  return {
    async fetch(
      request: Request,
      env: { INDEX: R2Bucket; INTERNAL_TOKEN: string },
    ) {
      isolate ??= crypto.randomUUID();
      if (
        request.headers.get("authorization") !== `Bearer ${env.INTERNAL_TOKEN}`
      )
        return new Response("Not found", { status: 404 });
      const path = new URL(request.url).pathname;
      if (path === "/pair-range-health")
        return Response.json({ code, isolate });
      const input = (await request.json()) as any;
      if (
        !/^[a-z0-9-]{1,80}$/.test(input.build) ||
        !/^[a-z0-9-]{1,70}$/.test(input.task)
      )
        return new Response("Invalid range task", { status: 400 });
      const key = `cws-build/${input.build}/range-${input.task}.json`,
        fingerprint = await digest(jsonBytes({ code, path, input })),
        old = await env.INDEX.get(key);
      if (old) {
        const saved = await old.json<any>();
        if (saved.fingerprint !== fingerprint)
          throw Error("Changed pair range task");
        return Response.json({ ...saved.result, reused: true });
      }
      const started = performance.now(),
        store = new BuildStore(env.INDEX),
        output = await pairRangeJob(store, path, input),
        result = {
          output,
          writesAndMergeReads: store.requests,
          writeAndMergeBytes: store.bytes,
          telemetry: {
            isolate,
            code,
            build: input.build,
            task: input.task,
            operation: path,
            wallMs: performance.now() - started,
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
