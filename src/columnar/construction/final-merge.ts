import { BuildStore, type Run, type MergeState } from "./runs.js";
import { MergedPostingReader } from "./merged-reader.js";
import {
  finishPostings,
  initialFinishState,
  ObjectStore,
  PackedWriter,
  type FinishState,
} from "./finish.js";
import { SummaryReader, type SummaryCursor } from "./term-summaries.js";
import type { Catalogue } from "./catalogue.js";
import { encodeDirectoryBlock, type DirectoryTerm } from "../term-directory.js";
import { encodeTermShard } from "../term-shard.js";
import { transformBlock } from "./block-codec.js";
import type { Ref } from "../format.js";

export interface FinalMergeState {
  version: 3;
  catalogue: string;
  partition: number;
  merge: MergeState;
  finish: FinishState;
  summary: SummaryCursor;
}
/** No materialized final run, JSON dictionaries, packet-terms conversion, or
 * tiered-terms copy pass. Binary metadata and cold shards are emitted in order
 * while the exact serving packet builder consumes the merge. */
export async function finalMerge(
  store: BuildStore,
  runs: Run[],
  catalogue: Catalogue,
  identity: string,
  partition: number,
  objectBase: number,
  saved?: FinalMergeState,
  byteBudget = 32 * 1048576,
) {
  const part = catalogue.partitions[partition];
  if (
    !part ||
    !/^[a-f0-9]{64}$/.test(identity) ||
    (saved &&
      (saved.version !== 3 ||
        saved.catalogue !== identity ||
        saved.partition !== partition))
  )
    throw Error("Final merge catalogue/checkpoint mismatch");
  const firstWord = part.summaries.chunks[0]?.firstWord,
    endWord =
      catalogue.partitions[partition + 1]?.summaries.chunks[0]?.firstWord;
  const reader = new MergedPostingReader(store, runs, saved?.merge, {
      firstWord,
      endWord,
    }),
    summaries = new SummaryReader(store, part.summaries, saved?.summary),
    objects = new ObjectStore(store, objectBase),
    writer = new PackedWriter(objects);
  const hot: [string, DirectoryTerm][] = [],
    cold: { first: string; count: number; ref: Ref }[] = [];
  let pending: [string, DirectoryTerm][] = [],
    inline: { ref: Ref; data: Uint8Array }[] = [],
    estimated = 0,
    terms = 0,
    inlineTerms = 0;
  const flushCold = async () => {
    if (!pending.length) return;
    cold.push({
      first: pending[0][0],
      count: pending.length,
      ref: await writer.put(
        encodeTermShard(
          await transformBlock(encodeDirectoryBlock(pending)),
          inline,
        ),
      ),
    });
    pending = [];
    inline = [];
    estimated = 0;
  };
  const result = await finishPostings(
    store,
    { ...runs[0], chunks: [] },
    {
      count: catalogue.documents,
      avgBody: catalogue.bodyTokens / catalogue.documents,
      avgTitle: catalogue.titleTokens / catalogue.documents,
    },
    objectBase,
    saved?.finish ??
      initialFinishState({
        first: { chunk: 0, at: 0 },
        firstTerm: part.firstId,
      }),
    byteBudget,
    undefined,
    {
      reader,
      objects,
      term: async (word, term, data) => {
        const expected = await summaries.peek();
        if (
          !expected ||
          expected.word !== word ||
          expected.df !== term.df ||
          expected.body !== term.bodyOccurrences ||
          expected.title !== term.titleOccurrences ||
          term.id < part.firstId ||
          term.id >= part.firstId + part.count
        )
          throw Error("Final postings differ from authoritative catalogue");
        summaries.consume();
        terms++;
        if (
          term.df > catalogue.hot.df ||
          (term.df === catalogue.hot.df && term.id <= catalogue.hot.lastId)
        )
          hot.push([word, term]);
        else {
          const small =
            !term.tree.height &&
            !term.frequencyParts?.length &&
            !term.positionalParts?.length &&
            term.frequencies[2] + term.positional[2] <= 4096;
          const useful = small
            ? data.filter(
                (d) =>
                  d.ref.join(":") === term.frequencies.join(":") ||
                  d.ref.join(":") === term.positional.join(":"),
              )
            : [];
          const n =
            256 +
            word.length * 3 +
            useful.reduce((n, d) => n + d.data.length + 16, 0);
          if (
            pending.length &&
            (pending.length >= 512 || estimated + n > 128 * 1024)
          )
            await flushCold();
          pending.push([word, term]);
          inline.push(...useful);
          estimated += n;
          if (useful.length === 2) inlineTerms++;
        }
      },
    },
  );
  await flushCold();
  await writer.flush();
  const hotBlocks = [];
  for (let first = 0; first < hot.length; first += 4096) {
    const rows = hot.slice(first, first + 4096),
      ref = await store.put(await transformBlock(encodeDirectoryBlock(rows)));
    hotBlocks.push({ first: rows[0][0], count: rows.length, ref });
  }
  if (
    result.state.done &&
    ((await summaries.peek()) ||
      result.state.nextTerm !== part.firstId + part.count)
  )
    throw Error("Incomplete final catalogue partition");
  return {
    state: {
      version: 3,
      catalogue: identity,
      partition,
      merge: reader.snapshot(),
      finish: result.state,
      summary: summaries.cursor,
    } as FinalMergeState,
    objects: objects.objects,
    hot: hotBlocks,
    cold,
    terms,
    inlineTerms,
    processed: result.processed,
  };
}
