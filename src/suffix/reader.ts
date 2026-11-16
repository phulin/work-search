import { Semaphore, Lru } from "../columnar/storage.js";
import {
  PREFIX_WORDS,
  canonicalBit,
  type SuffixBlock,
  type SuffixColumn,
  type SuffixManifest,
} from "./format.js";
import { comparePhrase, decodeSuffixKeys } from "./keys.js";
import { decodeRankingHeads } from "./ranking-heads.js";
import { quantizerForMaximum } from "./format.js";
import { SuffixFences } from "./fences.js";
import { PhraseIntervals } from "./intervals.js";
import { PhraseRanks } from "./phrase-ranks.js";
export type SuffixRead = (
  file: string,
  offset: number,
  bytes: number,
) => Promise<Uint8Array>;
export interface SuffixBatch {
  block: SuffixBlock;
  first: number;
  end: number;
  columns: Partial<Record<SuffixColumn, Uint8Array>>;
  sourceRows?: Uint16Array;
  excludedRows?: Uint16Array;
  scoreBits?: 8 | 16;
}
async function inflate(raw: Uint8Array) {
  return new Uint8Array(
    await new Response(
      new Response(raw as BodyInit).body!.pipeThrough(
        new DecompressionStream("gzip"),
      ),
    ).arrayBuffer(),
  );
}
/** No process-wide state: cold requests retain only bounded decoded columns. */
export class SuffixReader {
  readonly stats = {
    reads: 0,
    bytes: 0,
    decodedBytes: 0,
    boundaryWaves: 0,
    scanBatches: 0,
    rows: 0,
    rescoreCandidates: 0,
    skippedBlocks: 0,
    skippedGroups: 0,
    coalescedReads: 0,
    coalescedExtraBytes: 0,
    precisionRefinements: 0,
    refinedRows: 0,
    frequencyRescores: 0,
    rankingReads: 0,
    rankingBytes: 0,
    rankingRows: 0,
    rankingSkippedBlocks: 0,
    rankingPrefetchUnused: 0,
    intervalHits: 0,
    phraseRankHits: 0,
    remotePhraseRankHits: 0,
    membershipRows: 0,
    intersectionCandidates: 0,
  };
  private slots = new Semaphore(6);
  private cache = new Lru<Uint8Array>(8 * 1048576);
  private pending = new Map<string, Promise<Uint8Array>>();
  private directories = new Lru<SuffixBlock[]>(4 * 1048576);
  private directoryPending = new Map<number, Promise<SuffixBlock[]>>();
  private fences?: SuffixFences;
  private intervals?: PhraseIntervals;
  private phraseRanks?: PhraseRanks;
  private phraseRankIndex?: PhraseRanks;
  get buffers() {
    return {
      bundledBytes:
        (this.fences?.bytes.byteLength ?? 0) +
        (this.intervals?.bytes.byteLength ?? 0) +
        (this.phraseRanks?.bytes.byteLength ?? 0) +
        (this.phraseRankIndex?.bytes.byteLength ?? 0),
      retainedColumnBytes: this.cache.bytes,
      peakRetainedColumnBytes: this.cache.peak,
      retainedDirectoryBytes: this.directories.bytes,
      peakRetainedDirectoryBytes: this.directories.peak,
    };
  }
  constructor(
    readonly manifest: SuffixManifest,
    readonly source: SuffixRead,
    fences?: Uint8Array,
    readonly options: {
      rankingLookahead?: number;
      intervals?: Uint8Array;
      phraseRanks?: Uint8Array;
      phraseRankIndex?: Uint8Array;
    } = {},
  ) {
    if (manifest.format !== "word-suffix-1" || manifest.fixed.titleBoost !== 2)
      throw Error("Invalid suffix manifest");
    if (fences) this.fences = new SuffixFences(fences, manifest);
    if (
      options.rankingLookahead !== undefined &&
      (!Number.isInteger(options.rankingLookahead) ||
        options.rankingLookahead < 1 ||
        options.rankingLookahead > 6)
    )
      throw Error("Invalid suffix ranking lookahead");
    if (options.intervals)
      this.intervals = new PhraseIntervals(
        options.intervals,
        manifest.corpusGeneration,
        manifest.rows,
      );
    if (options.phraseRanks)
      this.phraseRanks = new PhraseRanks(
        options.phraseRanks,
        manifest.corpusGeneration,
        manifest.rows,
        manifest.count,
      );
    if (options.phraseRankIndex) {
      const rows =
        manifest.phraseRankRows && manifest.files[manifest.phraseRankRows];
      if (!rows) throw Error("Missing suffix phrase ranking payload");
      this.phraseRankIndex = new PhraseRanks(
        options.phraseRankIndex,
        manifest.corpusGeneration,
        manifest.rows,
        manifest.count,
        rows.bytes,
      );
    }
  }
  /** The omitted-score bound must lose strictly, including possible ties.
   * Cursor/deeper pages keep the complete suffix scan. */
  async phraseRanking(phrase: Uint32Array, limit: number, after?: unknown) {
    if (after || limit < 1) return;
    let record = this.phraseRanks?.lookup(phrase),
      remote = false;
    if (!record && this.phraseRankIndex) {
      const ref = this.phraseRankIndex.locate(phrase);
      if (!ref || ref.count < limit) return;
      record = {
        entries: this.phraseRankIndex.decode(
          await this.read(
            this.manifest.phraseRankRows!,
            ref.offset,
            ref.length,
            false,
          ),
        ),
        tailUpper: ref.tailUpper,
      };
      remote = true;
    }
    if (!record || record.entries.length < limit) return;
    const ordered = record.entries.slice().sort((a, b) => b.lower - a.lower),
      threshold = ordered[limit - 1].lower;
    if (record.tailUpper >= threshold) return;
    this.stats.phraseRankHits++;
    if (remote) this.stats.remotePhraseRankHits++;
    return ordered
      .filter((e) => e.upper >= threshold)
      .sort((a, b) => a.doc - b.doc);
  }
  async read(file: string, offset: number, length: number, compressed = true) {
    const key = `${file}:${offset}:${length}:${compressed}`;
    const old = this.cache.get(key);
    if (old) return old;
    let task = this.pending.get(key);
    if (!task) {
      task = this.slots.run(async () => {
        this.stats.reads++;
        this.stats.bytes += length;
        if (file === "ranking") {
          this.stats.rankingReads++;
          this.stats.rankingBytes += length;
        }
        const raw = await this.source(file, offset, length);
        if (raw.length !== length) throw Error("Truncated suffix range");
        const data = compressed ? await inflate(raw) : raw;
        this.stats.decodedBytes += data.length;
        this.cache.set(key, data, data.length);
        return data;
      });
      this.pending.set(key, task);
    }
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }
  async blocks(phrase: Uint32Array) {
    const short = phrase.subarray(0, PREFIX_WORDS),
      groups = this.manifest.directory.filter(
        (d) =>
          comparePhrase(d.high, short) >= 0 && comparePhrase(d.low, short) <= 0,
      );
    if (!groups.length) return [];
    this.stats.boundaryWaves++;
    const blocks = (
      await Promise.all(
        groups.map(
          async (d) =>
            JSON.parse(
              new TextDecoder().decode(
                await this.read("directory", d.ref.offset, d.ref.length),
              ),
            ) as SuffixBlock[],
        ),
      )
    ).flat();
    return blocks.filter(
      (b) =>
        comparePhrase(b.high, short) >= 0 && comparePhrase(b.low, short) <= 0,
    );
  }
  private async directory(group: SuffixManifest["directory"][number]) {
    const key = String(group.ref.offset),
      old = this.directories.get(key);
    if (old) return old;
    let task = this.directoryPending.get(group.ref.offset);
    if (!task) {
      task = (async () => {
        const raw = await this.read(
            "directory",
            group.ref.offset,
            group.ref.length,
          ),
          blocks = JSON.parse(new TextDecoder().decode(raw)) as SuffixBlock[];
        // Account conservatively for parsed object overhead as well as bytes.
        this.directories.set(key, blocks, raw.length * 4);
        return blocks;
      })();
      this.directoryPending.set(group.ref.offset, task);
    }
    try {
      return await task;
    } finally {
      this.directoryPending.delete(group.ref.offset);
    }
  }
  minimumRows(phrase: Uint32Array) {
    if (!phrase.length || phrase.some((x) => !x)) return 0;
    const known = this.intervals?.lookup(phrase);
    if (known) return known.end - known.first;
    const short = phrase.subarray(0, PREFIX_WORDS);
    if (phrase.length > PREFIX_WORDS) return 0;
    return this.manifest.directory.reduce(
      (n, g) =>
        n +
        (comparePhrase(g.low, short) === 0 && comparePhrase(g.high, short) === 0
          ? g.end - g.first
          : 0),
      0,
    );
  }
  async expand(
    interval: {
      first: number;
      end: number;
      groups: SuffixManifest["directory"];
    },
    columns?: SuffixColumn[],
  ) {
    if (
      this.fences &&
      columns?.length &&
      columns.every(
        (c) => c === "keys" || c === "documents" || c === "positions",
      )
    )
      return {
        ...interval,
        blocks: this.fences.blocks(interval.first, interval.end),
      };
    const blocks = (
      await Promise.all(interval.groups.map((g) => this.directory(g)))
    )
      .flat()
      .filter(
        (b) => b.first < interval.end && b.first + b.count > interval.first,
      );
    return { first: interval.first, end: interval.end, blocks };
  }
  private async shortBoundary(
    block: SuffixBlock,
    phrase: Uint32Array,
    upper: boolean,
  ) {
    if (!upper && comparePhrase(block.low, phrase) === 0) return block.first;
    if (upper && comparePhrase(block.high, phrase) === 0)
      return block.first + block.count;
    const keys = decodeSuffixKeys(
      await this.column(block, "keys"),
      block.count,
    );
    let lo = 0,
      hi = block.count;
    while (lo < hi) {
      const m = (lo + hi) >>> 1,
        cmp = comparePhrase(
          keys.subarray(m * PREFIX_WORDS, (m + 1) * PREFIX_WORDS),
          phrase,
        );
      if (cmp < 0 || (upper && cmp === 0)) lo = m + 1;
      else hi = m;
    }
    return block.first + lo;
  }
  /** Short phrases need just the two edge groups to establish exact bounds.
   * Interior directories remain unopened until their score bound is competitive. */
  async shortInterval(phrase: Uint32Array) {
    if (
      !phrase.length ||
      phrase.length > PREFIX_WORDS ||
      phrase.some((x) => !x)
    )
      return { first: 0, end: 0, groups: [] as SuffixManifest["directory"] };
    const known = this.intervals?.lookup(phrase);
    if (known) {
      this.stats.intervalHits++;
      return {
        ...known,
        groups: this.manifest.directory.filter(
          (g) => g.first < known.end && g.end > known.first,
        ),
      };
    }
    const groups = this.manifest.directory.filter(
      (d) =>
        comparePhrase(d.high, phrase) >= 0 && comparePhrase(d.low, phrase) <= 0,
    );
    if (!groups.length) return { first: 0, end: 0, groups };
    const bounds = this.fences?.bounds(phrase);
    if (bounds) {
      this.stats.boundaryWaves++;
      const [first, end] = await Promise.all([
        this.shortBoundary(bounds[0], phrase, false),
        this.shortBoundary(bounds[1], phrase, true),
      ]);
      return {
        first,
        end,
        groups: this.manifest.directory.filter(
          (g) => g.first < end && g.end > first,
        ),
      };
    }
    this.stats.boundaryWaves++;
    const edges = await Promise.all([
        this.directory(groups[0]),
        this.directory(groups.at(-1)!),
      ]),
      select = (blocks: SuffixBlock[]) =>
        blocks.filter(
          (b) =>
            comparePhrase(b.high, phrase) >= 0 &&
            comparePhrase(b.low, phrase) <= 0,
        );
    const left = select(edges[0]),
      right = select(edges[1]);
    if (!left.length || !right.length)
      return { first: 0, end: 0, groups: [] as SuffixManifest["directory"] };
    this.stats.boundaryWaves++;
    const [first, end] = await Promise.all([
      this.shortBoundary(left[0], phrase, false),
      this.shortBoundary(right.at(-1)!, phrase, true),
    ]);
    return {
      first,
      end,
      groups: groups.filter((g) => g.first < end && g.end > first),
    };
  }
  async *rankedScan(
    phrase: Uint32Array,
    columns: SuffixColumn[],
    admit: (maximum: number) => boolean,
  ): AsyncGenerator<SuffixBatch> {
    const interval = await this.shortInterval(phrase),
      index = phrase.length - 2,
      maximum = (g: SuffixManifest["directory"][number]) =>
        g.scoreMaximum?.[index] ?? Infinity;
    interval.groups.sort(
      (a, b) =>
        maximum(b) - maximum(a) || (a.minDocument ?? 0) - (b.minDocument ?? 0),
    );
    const headFor = (group: SuffixManifest["directory"][number]) => {
        const overlap =
            Math.min(interval.end, group.end) -
            Math.max(interval.first, group.first),
          head = group.ranking?.[phrase.length];
        return head && (overlap > 16384 || head.length <= 16384)
          ? head
          : undefined;
      },
      lookahead = this.options.rankingLookahead ?? 6,
      prefetched = new Map<
        SuffixManifest["directory"][number],
        { task: Promise<Uint8Array>; bytes: number }
      >();
    let buffered = 0;
    const fill = (from: number) => {
      for (
        let i = from;
        i < interval.groups.length && prefetched.size < lookahead;
        i++
      ) {
        const group = interval.groups[i],
          ref = headFor(group);
        if (!ref || prefetched.has(group) || !admit(maximum(group))) continue;
        if (buffered + ref.length > 1048576 && prefetched.size) break;
        const task = this.read("ranking", ref.offset, ref.length);
        void task.catch(() => {});
        prefetched.set(group, { task, bytes: ref.length });
        buffered += ref.length;
      }
    };
    try {
      for (const [groupIndex, group] of interval.groups.entries()) {
        fill(groupIndex);
        if (!admit(maximum(group))) {
          this.stats.skippedGroups++;
          const unused = prefetched.get(group);
          if (unused) {
            this.stats.rankingPrefetchUnused++;
            buffered -= unused.bytes;
            prefetched.delete(group);
          }
          continue;
        }
        // A few mixed-prefix blocks are cheaper to scan than opening a summary
        // for every other phrase in the directory group as well.
        const ranking = headFor(group);
        if (ranking) {
          const ready = prefetched.get(group),
            raw = ready
              ? await ready.task
              : await this.read("ranking", ranking.offset, ranking.length);
          if (ready) {
            buffered -= ready.bytes;
            prefetched.delete(group);
          }
          if (lookahead > 1) fill(groupIndex + 1);
          const heads = decodeRankingHeads(
            raw,
            phrase.length,
            group.first,
            group.end,
          ).filter(
            (h) =>
              h.block.first < interval.end &&
              h.block.first + h.block.count > interval.first,
          );
          heads.sort(
            (a, b) =>
              b.block.scoreMaximum[index] - a.block.scoreMaximum[index] ||
              a.block.minDocument - b.block.minDocument,
          );
          const active = heads.filter((h) => {
            if (admit(h.block.scoreMaximum[index])) return true;
            this.stats.skippedBlocks++;
            return false;
          });
          for (const head of active) {
            const selected = Uint16Array.from(
                { length: head.rows.length },
                (_, i) => i,
              ).filter((i) => {
                const row = head.block.first + head.rows[i];
                return row >= interval.first && row < interval.end;
              }),
              rows = Uint16Array.from(selected, (i) => head.rows[i]),
              codes = Uint16Array.from(selected, (i) => head.codes[i]),
              docs = Uint32Array.from(selected, (i) => head.docs[i]),
              positions = Uint32Array.from(selected, (i) => head.positions[i]),
              flags = new Uint16Array(selected.length).fill(
                canonicalBit(phrase.length, "all"),
              );
            this.stats.rankingRows += rows.length;
            this.stats.rows += rows.length;
            yield {
              block: head.block,
              first: 0,
              end: rows.length,
              sourceRows: rows,
              scoreBits: 16,
              columns: {
                documents: new Uint8Array(docs.buffer),
                positions: new Uint8Array(positions.buffer),
                flags: new Uint8Array(flags.buffer),
                [`score16-${phrase.length}`]: new Uint8Array(codes.buffer),
              },
            };
          }
          const byFirst = new Map(active.map((h) => [h.block.first, h])),
            remainder = (h: (typeof heads)[number]) => {
              const q = quantizerForMaximum(h.block.scoreMaximum[index], 16);
              return (
                Math.min(q.maximum, (h.remainder + 1) * q.step) +
                128 * Number.EPSILON * Math.max(1, q.maximum)
              );
            },
            needs = (h: (typeof heads)[number]) =>
              !h.complete && admit(remainder(h));
          for (const h of active)
            if (!needs(h)) this.stats.rankingSkippedBlocks++;
          for await (const batch of this.scan(
            { ...interval, blocks: active.map((h) => h.block) },
            columns,
            (b) => needs(byFirst.get(b.first)!),
            4,
          )) {
            batch.excludedRows = byFirst
              .get(batch.block.first)!
              .rows.slice()
              .sort();
            yield batch;
          }
          continue;
        }
        const blocks = (await this.directory(group)).filter(
          (b) => b.first < interval.end && b.first + b.count > interval.first,
        );
        blocks.sort(
          (a, b) =>
            b.scoreMaximum[index] - a.scoreMaximum[index] ||
            a.minDocument - b.minDocument,
        );
        const eager =
          blocks.length <= 2 &&
          blocks.reduce(
            (n, b) =>
              n + b.columns.documents.length + b.columns.positions.length,
            0,
          ) <= 65536;
        const selectedColumns = eager
          ? [
              ...new Set([
                ...columns,
                "documents" as const,
                "positions" as const,
              ]),
            ]
          : columns;
        yield* this.scan(
          { ...interval, blocks },
          selectedColumns,
          (b) => admit(b.scoreMaximum[index]),
          4,
        );
      }
    } finally {
      await Promise.allSettled([...this.pending.values()]);
    }
  }
  async column(block: SuffixBlock, name: SuffixColumn) {
    const ref = block.columns[name];
    if (!ref) throw Error("Missing suffix column");
    return this.read(name, ref.offset, ref.length);
  }
  /** Compression frames stay independent; adjacent selected frames can share
   * one physical range request. Small gaps buy fewer cold requests while the
   * extent and decoded scan batches bound active memory. */
  async columns(blocks: SuffixBlock[], names: SuffixColumn[]) {
    type Job = {
      file: SuffixColumn;
      offset: number;
      length: number;
      key: string;
    };
    const jobs: Job[] = [],
      seen = new Set<string>();
    for (const block of blocks)
      for (const file of names) {
        const ref = block.columns[file];
        if (!ref) throw Error("Missing suffix column");
        const key = `${file}:${ref.offset}:${ref.length}:true`;
        if (seen.has(key) || this.cache.get(key) || this.pending.has(key))
          continue;
        seen.add(key);
        jobs.push({ file, ...ref, key });
      }
    jobs.sort((a, b) => a.file.localeCompare(b.file) || a.offset - b.offset);
    for (let at = 0; at < jobs.length;) {
      const first = jobs[at++],
        group = [first];
      let end = first.offset + first.length;
      while (
        at < jobs.length &&
        jobs[at].file === first.file &&
        jobs[at].offset <= end + 4096 &&
        jobs[at].offset + jobs[at].length - first.offset <= 262144
      ) {
        const next = jobs[at++];
        group.push(next);
        end = Math.max(end, next.offset + next.length);
      }
      const task = this.slots.run(async () => {
        this.stats.reads++;
        this.stats.bytes += end - first.offset;
        if (group.length > 1) {
          this.stats.coalescedReads++;
          this.stats.coalescedExtraBytes +=
            end - first.offset - group.reduce((n, j) => n + j.length, 0);
        }
        const raw = await this.source(
          first.file,
          first.offset,
          end - first.offset,
        );
        if (raw.length !== end - first.offset)
          throw Error("Truncated suffix range");
        return Promise.all(
          group.map(async (j) => {
            const data = await inflate(
              raw.subarray(
                j.offset - first.offset,
                j.offset - first.offset + j.length,
              ),
            );
            this.stats.decodedBytes += data.length;
            this.cache.set(j.key, data, data.length);
            return data;
          }),
        );
      });
      group.forEach((job, i) => {
        const part = task.then((values) => values[i]);
        this.pending.set(job.key, part);
        void part
          .finally(() => {
            if (this.pending.get(job.key) === part)
              this.pending.delete(job.key);
          })
          .catch(() => {});
      });
    }
    return new Map(
      await Promise.all(
        blocks.map(
          async (b) =>
            [
              b,
              Object.fromEntries(
                await Promise.all(
                  names.map(async (name) => [name, await this.column(b, name)]),
                ),
              ),
            ] as const,
        ),
      ),
    );
  }
  private async compareLong(offset: number, phrase: Uint32Array) {
    let used = 0;
    while (used < phrase.length) {
      const words = Math.min(phrase.length - used, 128),
        at = offset + used,
        bytes = await this.read(
          "tokens",
          at * 4,
          Math.min(words * 4, this.manifest.files.tokens.bytes - at * 4),
          false,
        ),
        v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < bytes.length / 4; i++, used++) {
        const token = v.getUint32(i * 4, true);
        if (!token || token !== phrase[used]) return token - phrase[used];
      }
      if (!bytes.length) throw Error("Unterminated suffix tokens");
    }
    return 0;
  }
  async interval(phrase: Uint32Array) {
    if (!phrase.length || phrase.some((x) => !x))
      return { first: 0, end: 0, blocks: [] as SuffixBlock[] };
    const blocks = await this.blocks(phrase);
    if (!blocks.length) return { first: 0, end: 0, blocks };
    this.stats.boundaryWaves++;
    const boundary = async (block: SuffixBlock, upper: boolean) => {
      const keys = decodeSuffixKeys(
          await this.column(block, "keys"),
          block.count,
        ),
        offsets =
          phrase.length > PREFIX_WORDS
            ? await this.column(block, "offsets").then(
                (b) => new DataView(b.buffer, b.byteOffset, b.byteLength),
              )
            : undefined;
      let lo = 0,
        hi = block.count;
      while (lo < hi) {
        const m = (lo + hi) >>> 1,
          short = comparePhrase(
            keys.subarray(m * PREFIX_WORDS, (m + 1) * PREFIX_WORDS),
            phrase.subarray(0, PREFIX_WORDS),
          ),
          cmp =
            !short && offsets
              ? await this.compareLong(offsets.getUint32(m * 4, true), phrase)
              : short;
        if (cmp < 0 || (upper && cmp === 0)) lo = m + 1;
        else hi = m;
      }
      return block.first + lo;
    };
    const [first, end] = await Promise.all([
      boundary(blocks[0], false),
      boundary(blocks.at(-1)!, true),
    ]);
    // Prefix truncation can leave many equal blocks for a long phrase. Resolve
    // block fences by exact comparisons before selecting the two edge blocks.
    if (phrase.length > PREFIX_WORDS && blocks.length > 1) {
      const locate = async (upper: boolean) => {
        let lo = 0,
          hi = blocks.length;
        while (lo < hi) {
          const m = (lo + hi) >>> 1,
            b = blocks[m],
            raw = await this.column(b, "offsets"),
            v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength),
            cmp = await this.compareLong(
              v.getUint32((b.count - 1) * 4, true),
              phrase,
            );
          if (cmp < 0 || (upper && cmp === 0)) lo = m + 1;
          else hi = m;
        }
        return lo === blocks.length
          ? blocks.at(-1)!.first + blocks.at(-1)!.count
          : boundary(blocks[lo], upper);
      };
      const [a, b] = await Promise.all([locate(false), locate(true)]);
      return {
        first: a,
        end: b,
        blocks: blocks.filter((x) => x.first + x.count > a && x.first < b),
      };
    }
    return {
      first,
      end,
      blocks: blocks.filter((b) => b.first + b.count > first && b.first < end),
    };
  }
  async *scan(
    interval: Awaited<ReturnType<SuffixReader["interval"]>>,
    columns: SuffixColumn[],
    admit?: (block: SuffixBlock) => boolean,
    batchSize = 16,
  ): AsyncGenerator<SuffixBatch> {
    // Fixed batches bound decoded bytes independently of total interval size.
    for (let i = 0; i < interval.blocks.length; i += batchSize) {
      const selected = interval.blocks.slice(i, i + batchSize).filter((b) => {
        if (!admit || admit(b)) return true;
        this.stats.skippedBlocks++;
        return false;
      });
      if (!selected.length) continue;
      this.stats.scanBatches++;
      const fetched = await this.columns(selected, columns);
      const batches = selected.map((block) => ({
        block,
        first: Math.max(0, interval.first - block.first),
        end: Math.min(block.count, interval.end - block.first),
        columns: fetched.get(block)!,
      }));
      for (const batch of batches) {
        this.stats.rows += batch.end - batch.first;
        yield batch;
      }
    }
  }
  async membership(phrase: Uint32Array, field: "all" | "body" | "title") {
    const interval = await this.interval(phrase),
      docs: number[] = [];
    for await (const batch of this.scan(interval, [
      "documents",
      "positions",
      ...(phrase.length >= 2 && phrase.length <= 5 ? ["flags" as const] : []),
    ])) {
      const d = batch.columns.documents!,
        p = batch.columns.positions!,
        f = batch.columns.flags,
        dv = new DataView(d.buffer, d.byteOffset, d.byteLength),
        pv = new DataView(p.buffer, p.byteOffset, p.byteLength),
        fv = f ? new DataView(f.buffer, f.byteOffset, f.byteLength) : undefined;
      for (let i = batch.first; i < batch.end; i++) {
        const title = pv.getUint32(i * 4, true) >= 2 ** 31;
        if ((field === "body" && title) || (field === "title" && !title))
          continue;
        if (
          fv &&
          !(fv.getUint16(i * 2, true) & canonicalBit(phrase.length, field))
        )
          continue;
        docs.push(dv.getUint32(i * 4, true));
      }
    }
    docs.sort((a, b) => a - b);
    return Uint32Array.from(docs.filter((d, i) => !i || d !== docs[i - 1]));
  }
}
