import {
  BuildStore,
  digest,
  jsonBytes,
} from "../../src/columnar/construction/runs.js";
import { mergePairStatisticsRuns } from "../../src/columnar/construction/pair-statistics-runs.js";
/** Temporary execution-only upgrade for an in-progress immutable pair build. */
export function createPairIOWorker(code: string) {
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
      if (new URL(request.url).pathname === "/pair-io-health")
        return Response.json({ code, format: "CPS1-stream-v1", isolate });
      const started = performance.now(),
        input = (await request.json()) as any;
      if (
        !/^[a-z0-9-]{1,80}$/.test(input.build) ||
        !/^[a-z0-9-]{1,70}$/.test(input.task)
      )
        return new Response("Invalid merge task", { status: 400 });
      const key = `cws-build/${input.build}/overlap-${input.task}.json`,
        fingerprint = await digest(jsonBytes({ code, input })),
        old = await env.INDEX.get(key);
      if (old) {
        const saved = await old.json<any>();
        if (saved.fingerprint !== fingerprint)
          throw Error("Changed overlapping merge task");
        return Response.json({ ...saved.result, reused: true });
      }
      const store = new BuildStore(env.INDEX),
        output = await mergePairStatisticsRuns(store, input.runs),
        result = {
          output,
          writesAndMergeReads: store.requests,
          writeAndMergeBytes: store.bytes,
          telemetry: {
            isolate,
            code,
            build: input.build,
            task: input.task,
            operation: "/merge-pair-statistics-io",
            wallMs: performance.now() - started,
            queueMs: 0,
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
