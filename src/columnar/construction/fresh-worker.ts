import {
  BuildStore,
  digest,
  jsonBytes,
  ingest,
  merge,
  generationFor,
  type Chunk,
} from "./runs.js";
import { CorpusSource, type SourceRoot } from "./source.js";
import { ENGLISH_ANALYSIS } from "../../query/analysis.js";
import { countedBucket } from "./bucket.js";
import { mergeSummaries } from "./term-summaries.js";
import { cataloguePartition, type Catalogue } from "./catalogue.js";
import { ConstructionWordLookup } from "./word-lookup.js";
import { assembleWords } from "../word-directory.js";
import { concat, view } from "../format.js";
import { finalMerge } from "./final-merge.js";
import { finishDocumentGroup } from "./document-groups.js";
import { NumericWriter, numericDocuments } from "./numeric-staging.js";
import {
  documentGroupPairStatistics,
  PairStatistics,
} from "./pair-statistics.js";
import {
  storePairStatistics,
  mergePairStatisticsRuns,
  type PairStatisticsRun,
} from "./pair-statistics-runs.js";
import {
  documentGroupPairRuns,
  mergePairOccurrenceRuns,
} from "./pair-occurrences.js";
import type { NumericDocument } from "./analyzed-document.js";
import { finishPairsJob } from "./pair-jobs.js";
import { finishPairDirectoryJob } from "./pair-directory-job.js";
import { StagingContainer } from "./staging-container.js";
import {
  storeSelection,
  readSelection,
  occurrenceSelection,
} from "./selection-packets.js";

const VERSION = "fresh-construction-v3";
export function createFreshConstructionWorker(root: SourceRoot, code: string) {
  let active = false;
  let isolate: string | undefined;
  let activation:
    | { identity: string; catalogue: Catalogue; words: ConstructionWordLookup }
    | undefined;
  async function activate(store: BuildStore, ref: Chunk) {
    if (activation?.identity === ref.sha256) return activation;
    const catalogue: Catalogue = JSON.parse(
      new TextDecoder().decode(await store.get(ref)),
    );
    const expected = await digest(
      jsonBytes({
        sourceRoot: root,
        count: catalogue.documents,
        analysis: ENGLISH_ANALYSIS,
      }),
    );
    if (
      catalogue.format !== "construction-catalogue-v3" ||
      catalogue.source !== expected ||
      catalogue.analysis !== ENGLISH_ANALYSIS ||
      catalogue.documents > root.documents
    )
      throw Error("Catalogue source/analysis mismatch");
    const blocks: { first: string; count: number; data: Uint8Array }[] = [],
      ids: Uint8Array[] = [];
    let bytes = 0;
    for (const common of catalogue.common ?? []) {
      if ((bytes += common.words.size + common.ids.size) > 16 * 1048576)
        throw Error("Common dictionary exceeds activation budget");
      const [words, rawIds] = await store.getMany([common.words, common.ids]);
      if (rawIds.length !== common.count * 4)
        throw Error("Common catalogue ID count mismatch");
      blocks.push({ first: common.first, count: common.count, data: words });
      ids.push(rawIds);
    }
    const bundle =
      catalogue.commonBundle &&
      (await store.getMany([
        catalogue.commonBundle.hot,
        catalogue.commonBundle.ids,
      ]));
    if (bundle && bundle[0].length + bundle[1].length > 16 * 1048576)
      throw Error("Common dictionary exceeds activation budget");
    const rawIds = bundle?.[1] ?? concat(ids),
      values = new Uint32Array(rawIds.length / 4);
    for (let i = 0; i < values.length; i++)
      values[i] = view(rawIds).getUint32(i * 4, true);
    activation = {
      identity: ref.sha256,
      catalogue,
      words: new ConstructionWordLookup({
        generation: ref.sha256,
        rootSha256: ref.sha256,
        count: catalogue.documents,
        hot: bundle?.[0] ?? assembleWords(blocks),
        ids: values,
        packets: catalogue.words,
      }),
    };
    return activation;
  }
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
      if (path === "/health")
        return Response.json({
          format: VERSION,
          code,
          isolate,
          source: await digest(jsonBytes(root)),
          documents: root.documents,
        });
      if (active)
        return Response.json({ error: "Busy", isolate }, { status: 503 });
      active = true;
      const counted = countedBucket(env.INDEX),
        store = new BuildStore(counted.bucket),
        source = new CorpusSource(counted.bucket, root),
        started = performance.now();
      env = { ...env, INDEX: counted.bucket };
      let build: string | undefined, task: string | undefined;
      const telemetry = (extra = {}) => ({
        format: VERSION,
        code,
        isolate,
        build,
        task,
        operation: path,
        wallMs: performance.now() - started,
        queueMs: 0,
        io: counted.snapshot(),
        codec: {
          encodeMs: store.codecEncodeMs,
          decodeMs: store.codecDecodeMs,
          decodedBytes: store.decodedBytes,
          continuationDecodeBytes: store.continuationDecodeBytes,
        },
        ...extra,
      });
      try {
        if (path === "/object" && request.method === "PUT") {
          const raw = new Uint8Array(await request.arrayBuffer());
          if (raw.length > 32 * 1048576)
            throw Error("Coordinator object too large");
          const ref = await store.put(raw, "plan-0.bin");
          return Response.json({ ref, telemetry: telemetry() });
        }
        if (request.method !== "POST")
          return new Response("Method not allowed", { status: 405 });
        const input: any = await request.json();
        build = input.build;
        task = input.task;
        if (path === "/download") {
          const bytes = await store.get(input.ref);
          return new Response(bytes as BodyInit, {
            headers: {
              "x-construction-telemetry": JSON.stringify(telemetry()),
            },
          });
        }
        if (
          !build ||
          !task ||
          !/^[a-z0-9-]{1,80}$/.test(build) ||
          !/^[a-z0-9-]{1,80}$/.test(task)
        )
          throw Error("Invalid fresh task identity");
        const fingerprint = await digest(
            jsonBytes({ format: VERSION, code, source: root, path, input }),
          ),
          key = `cws-fresh-v3/${build}/${task}.json`,
          old = await env.INDEX.get(key);
        if (old) {
          const saved = await old.json<any>();
          if (saved.fingerprint !== fingerprint)
            throw Error("Task identity changed");
          return Response.json({
            output: saved.output,
            reused: true,
            originalWork: saved.telemetry,
            telemetry: telemetry({ reused: true }),
          });
        }
        if (input.stateRef)
          input.state = JSON.parse(
            new TextDecoder().decode(await store.get(input.stateRef)),
          );
        if (input.runsRef)
          input.runs = JSON.parse(
            new TextDecoder().decode(await store.get(input.runsRef)),
          );
        const format = {
          codec: input.codec ?? "delta-gzip-v3",
          blockBytes: input.blockBytes ?? 262144,
          containerBytes: input.containerBytes ?? 16 * 1048576,
        };
        if (
          !["raw", "gzip", "delta-gzip-v3"].includes(format.codec) ||
          ![65536, 262144, 1048576, 2097152].includes(format.blockBytes) ||
          ![1048576, 4 * 1048576, 16 * 1048576].includes(format.containerBytes)
        )
          throw Error("Invalid fresh block configuration");
        let output: any;
        if (path === "/ingest")
          output = await ingest(
            source,
            store,
            input.first,
            input.count,
            input.tokenBudget ?? 1048576,
            ENGLISH_ANALYSIS,
            { ...format, summaries: true },
          );
        else if (path === "/merge")
          output = await merge(
            store,
            input.runs,
            input.state,
            input.byteBudget ?? 128 * 1048576,
            input.range,
            format,
          );
        else if (path === "/summaries")
          output = await mergeSummaries(
            store,
            input.runs,
            input.state,
            input.termBudget ?? 100000,
          );
        else if (path === "/catalogue")
          output = await cataloguePartition(
            store,
            input.run,
            input.firstId,
            input.state,
            input.termBudget ?? 65536,
            input.selections,
          );
        else if (path === "/stage")
          output = await store.put(jsonBytes(input.value), "plan-0.bin");
        else if (path === "/selection")
          output = await storeSelection(store, input.value);
        else if (path === "/pack-common") {
          const blocks: { first: string; count: number; data: Uint8Array }[] =
              [],
            ids: Uint8Array[] = [];
          for (const p of input.common) {
            const raw = await store.getMany([p.words, p.ids]);
            blocks.push({ first: p.first, count: p.count, data: raw[0] });
            ids.push(raw[1]);
          }
          const hot = assembleWords(blocks),
            idBytes = concat(ids);
          if (hot.length + idBytes.length > 16 * 1048576)
            throw Error("Common dictionary exceeds activation budget");
          const refs = await store.putParts([hot, idBytes]);
          output = { hot: refs[0], ids: refs[1] };
        } else if (path === "/activate") {
          const a = await activate(store, input.catalogueRef);
          output = {
            catalogue: a.identity,
            documents: a.catalogue.documents,
            terms: a.catalogue.terms,
          };
        } else if (path === "/final") {
          const a = await activate(store, input.catalogueRef);
          output = await finalMerge(
            store,
            input.runs,
            a.catalogue,
            a.identity,
            input.partition,
            input.objectBase,
            input.state,
            input.byteBudget,
          );
        } else if (path === "/packages") {
          const a = await activate(store, input.catalogueRef),
            numeric = new NumericWriter(store, input.first, a.identity),
            statistics: PairStatisticsRun[] = [],
            physicalStatistics = new StagingContainer(store),
            termIds = a.catalogue.pairTerms.map((t) => t.id);
          let pending: NumericDocument[] = [],
            tokens = 0;
          const flush = async () => {
            if (!pending.length || !termIds.length) return;
            const data = documentGroupPairStatistics(
              new Uint8Array(),
              new Uint32Array(),
              pending[0].doc,
              termIds,
              pending,
            );
            statistics.push(
              await storePairStatistics(
                store,
                new PairStatistics(data),
                a.identity,
                physicalStatistics,
              ),
            );
            pending = [];
            tokens = 0;
          };
          const result = await finishDocumentGroup(
            source,
            store,
            {
              generation: a.identity,
              count: a.catalogue.documents,
              analysis: ENGLISH_ANALYSIS,
              objects: [],
              idRouting: { dictionaries: [] },
            },
            undefined,
            input.generation,
            input.first,
            input.count,
            undefined,
            undefined,
            a.words.request(store),
            async (row) => {
              await numeric.append(row);
              if (termIds.length) {
                pending.push(row);
                tokens += row.body.length + row.title.length;
                if (tokens >= 131072) await flush();
              }
            },
          );
          await flush();
          await physicalStatistics.flush();
          output = { ...result, numeric: await numeric.finish(), statistics };
        } else if (path === "/merge-statistics")
          output = await mergePairStatisticsRuns(store, input.runs);
        else if (path === "/occurrences") {
          const selection = await occurrenceSelection(
            store,
            input.selectionRef,
          );
          output = {
            runs: await documentGroupPairRuns(
              store,
              new Uint8Array(),
              new Uint32Array(),
              input.numeric.first,
              selection,
              input.selectionRef.sha256,
              numericDocuments(store, input.numeric, input.catalogueRef.sha256),
            ),
          };
        } else if (path === "/merge-occurrences")
          output = await mergePairOccurrenceRuns(
            store,
            input.runs,
            input.range,
          );
        else if (path === "/finish-pairs") {
          const selected = await readSelection(
            store,
            input.selectionRef,
            input.range,
          );
          output = await finishPairsJob(store, input, {
            documents: selected.manifest.documents,
            vocabulary: selected.manifest.vocabulary,
            pairs: selected.pairs,
          });
        } else if (path === "/pair-directory")
          output = await finishPairDirectoryJob(store, input);
        else if (path === "/verify") {
          if (!Array.isArray(input.objects) || input.objects.length > 256)
            throw Error("Invalid object verification batch");
          for (let at = 0; at < input.objects.length; at += 4)
            await Promise.all(
              input.objects.slice(at, at + 4).map(async (o: any) => {
                const head = await env.INDEX.head(o.key);
                if (
                  !head ||
                  head.size !== o.size ||
                  head.customMetadata?.sha256 !== o.sha256
                )
                  throw Error("Missing or changed immutable output");
              }),
            );
          output = {
            count: input.objects.length,
            sha256: await digest(jsonBytes(input.objects)),
          };
        } else if (path === "/publish") {
          const published = JSON.parse(
            new TextDecoder().decode(await store.get(input.manifestRef)),
          );
          if (
            (await generationFor(published.root)) !== published.root.generation
          )
            throw Error("Invalid final generation");
          const a = await activate(store, published.catalogueRef);
          const { ColumnarIndex } = await import("../search.js");
          new ColumnarIndex(published.root);
          if (
            published.root.count !== a.catalogue.documents ||
            published.root.avgBody !==
              a.catalogue.bodyTokens / a.catalogue.documents ||
            published.root.avgTitle !==
              a.catalogue.titleTokens / a.catalogue.documents ||
            published.root.directory?.sha256 !==
              published.directoryRef?.sha256 ||
            published.root.directory?.bytes !== published.directoryRef?.size ||
            published.root.documentPackages?.locators?.sha256 !==
              published.documentsRef?.sha256 ||
            published.root.documentPackages?.locators?.bytes !==
              published.documentsRef?.size ||
            JSON.stringify(published.root.objects) !==
              JSON.stringify(
                published.objects.slice(0, published.root.objects.length),
              )
          )
            throw Error("Publication manifest/layout mismatch");
          let documents = 0;
          for (const group of published.groups) {
            if (group.first !== documents || group.end <= group.first)
              throw Error("Incomplete document coverage");
            documents = group.end;
          }
          if (
            documents !== a.catalogue.documents ||
            published.terms !== a.catalogue.terms
          )
            throw Error("Incomplete generation coverage");
          let verified = 0;
          for (const batch of published.verifications) {
            const object = await env.INDEX.get(
              `cws-fresh-v3/${build}/${batch.task}.json`,
            );
            if (!object) throw Error("Missing verification receipt");
            const receipt = (await object.json<any>()).output;
            const expected = published.objects.slice(
              verified,
              verified + receipt.count,
            );
            if (receipt.sha256 !== (await digest(jsonBytes(expected))))
              throw Error("Verification coverage mismatch");
            verified += receipt.count;
          }
          if (verified !== published.objects.length)
            throw Error("Incomplete immutable verification");
          await env.INDEX.put(
            `${published.root.generation}/root.json`,
            jsonBytes(published.root) as ArrayBufferView<ArrayBuffer>,
            { customMetadata: { generation: published.root.generation, code } },
          );
          output = {
            generation: published.root.generation,
            documents,
            terms: published.terms,
          };
        } else throw Error("Unknown fresh operation");
        if (output.state) {
          const stateRef = await store.put(
            jsonBytes(output.state),
            "plan-0.bin",
          );
          output = { ...output, stateRef };
        }
        // The persisted original excludes its own receipt PUT; current invocation
        // telemetry, returned after the PUT, includes it. Retry cost stays separate.
        await env.INDEX.put(
          key,
          jsonBytes({
            fingerprint,
            output,
            telemetry: telemetry(),
          }) as ArrayBufferView<ArrayBuffer>,
        );
        return Response.json({ output, telemetry: telemetry() });
      } catch (error) {
        const t = telemetry({ failed: true });
        console.log(JSON.stringify({ construction: t, error: String(error) }));
        return Response.json(
          { error: String(error), telemetry: t },
          { status: 500 },
        );
      } finally {
        active = false;
      }
    },
  };
}
