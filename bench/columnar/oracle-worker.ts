import {
  CorpusSource,
  type SourceRoot,
} from "../../src/columnar/construction/source.js";
import {
  BuildStore,
  digest,
  jsonBytes,
  type Chunk,
} from "../../src/columnar/construction/runs.js";
import {
  OracleScan,
  type OracleContract,
  type OracleStatistics,
} from "./oracle-scan.js";

export interface OracleConfiguration {
  corpusHash: string;
  statistics: OracleStatistics;
  contracts: OracleContract[];
}
export function createOracleWorker(sourceRoot: SourceRoot, code: string) {
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
      const sourceHash = await digest(jsonBytes(sourceRoot));
      if (new URL(request.url).pathname === "/oracle-health")
        return Response.json({ code, sourceHash, isolate });
      const input = (await request.json()) as {
          configuration: Chunk;
          first: number;
          end: number;
        },
        store = new BuildStore(env.INDEX),
        configuration: OracleConfiguration = JSON.parse(
          new TextDecoder().decode(await store.get(input.configuration)),
        ),
        { count } = configuration.statistics;
      if (
        !Number.isInteger(count) ||
        count < 1 ||
        count > sourceRoot.documents ||
        !Number.isInteger(input.first) ||
        !Number.isInteger(input.end) ||
        input.first < 0 ||
        input.end <= input.first ||
        input.end > count ||
        input.end - input.first > 4096 ||
        configuration.contracts.length > 256 ||
        configuration.statistics.names.length > 4096 ||
        configuration.corpusHash !==
          (await digest(jsonBytes({ sourceRoot, count })))
      )
        throw Error("Invalid oracle configuration/range");
      const receipt = `cws-oracle/${code}/${input.configuration.sha256}/${input.first}-${input.end}.json`,
        saved = await env.INDEX.get(receipt);
      if (saved) return Response.json(await saved.json());
      const started = performance.now(),
        source = new CorpusSource(env.INDEX, sourceRoot),
        scan = new OracleScan(
          configuration.statistics,
          configuration.contracts,
        );
      let next = input.first;
      while (next < input.end) {
        const part = source.part(next),
          n = Math.min(128, input.end - next, part.first + part.count - next),
          pointers = await source.pointers(next, n);
        await source.prefetch(pointers, 8 * 1048576);
        for (let row = 0; row < n; row++) {
          scan.add(await source.document(next, pointers, row));
          next++;
          if (
            scan.bodySum + scan.titleSum >= 1500000 ||
            performance.now() - started >= 15000
          )
            break;
        }
        if (
          scan.bodySum + scan.titleSum >= 1500000 ||
          performance.now() - started >= 15000
        )
          break;
      }
      const data = jsonBytes({
          kind: "independent-oracle-part",
          first: input.first,
          next,
          corpusHash: configuration.corpusHash,
          ...scan.result(),
        }),
        compressed = new Uint8Array(
          await new Response(
            new Response(data as BodyInit).body!.pipeThrough(
              new CompressionStream("gzip"),
            ),
          ).arrayBuffer(),
        ),
        output = await store.put(compressed),
        result = {
          first: input.first,
          next,
          output,
          telemetry: {
            code,
            isolate,
            wallMs: performance.now() - started,
            sourceRequests: source.requests,
            sourceBytes: source.bytes,
            resultBytes: compressed.length,
          },
        };
      await env.INDEX.put(
        receipt,
        jsonBytes(result) as ArrayBufferView<ArrayBuffer>,
      );
      return Response.json(result);
    },
  };
}
