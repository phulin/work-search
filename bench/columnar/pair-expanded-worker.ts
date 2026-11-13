import {
  BuildStore,
  digest,
  jsonBytes,
} from "../../src/columnar/construction/runs.js";
import {
  pairOccurrencesJob,
  finishPairsJob,
} from "../../src/columnar/construction/pair-jobs.js";
import { finishPairDirectoryJob } from "../../src/columnar/construction/pair-directory-job.js";
/** Temporary route adapter; frozen handlers remain unchanged during active builds. */
export function createExpandedPairWorker(code: string, statisticsCode: string) {
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
      if (path === "/expanded-pair-health")
        return Response.json({
          code,
          statisticsCode,
          format: "CPP3+CPD1",
          isolate,
        });
      const input = (await request.json()) as any;
      if (
        !/^[a-z0-9-]{1,80}$/.test(input.build) ||
        !/^[a-z0-9-]{1,70}$/.test(input.task)
      )
        throw Error("Invalid expanded pair task");
      const key = `cws-build/${input.build}/expanded-${input.task}.json`,
        fingerprint = await digest(jsonBytes({ code, path, input })),
        old = await env.INDEX.get(key);
      if (old) {
        const saved = await old.json<any>();
        if (saved.fingerprint !== fingerprint)
          throw Error("Changed expanded pair task");
        return Response.json({ ...saved.result, reused: true });
      }
      const started = performance.now(),
        store = new BuildStore(env.INDEX),
        output =
          path === "/expanded-pair-occurrences"
            ? await pairOccurrencesJob(store, input)
            : path === "/expanded-finish-pairs"
              ? await finishPairsJob(store, input)
              : path === "/expanded-pair-directory"
                ? await finishPairDirectoryJob(store, input)
                : undefined;
      if (!output) throw Error("Invalid expanded pair operation");
      const result = {
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
