import { DocumentPackage } from "./document-package.js";
import {
  PAGE,
  type Ref,
  type Branch,
  type Root,
  concat,
  decodeBranches,
  objectAt,
} from "./format.js";
export class Lru<T> {
  entries = new Map<string, { value: T; size: number }>();
  bytes = 0;
  peak = 0;
  constructor(readonly limit: number) {}
  get(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.value;
  }
  set(key: string, value: T, size: number) {
    size += key.length * 2 + 192;
    if (size > this.limit) return;
    const old = this.entries.get(key);
    if (old) {
      this.bytes -= old.size;
      this.entries.delete(key);
    }
    while (this.bytes + size > this.limit) {
      const [k, e] = this.entries.entries().next().value!;
      this.entries.delete(k);
      this.bytes -= e.size;
    }
    this.entries.set(key, { value, size });
    this.bytes += size;
    this.peak = Math.max(this.peak, this.bytes);
  }
  clear() {
    this.entries.clear();
    this.bytes = 0;
    this.peak = 0;
  }
}
export class Semaphore {
  active = 0;
  waiting: (() => void)[] = [];
  constructor(readonly slots: number) {}
  async run<T>(f: () => Promise<T>) {
    if (this.active >= this.slots)
      await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    try {
      return await f();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
// Cached immutable bytes use generation-scoped keys, just like application memory.
export interface SharedPages {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
}
export class Memory {
  pages = new Lru<Uint8Array>(24 * 1048576);
  decoded = new Lru<unknown>(4 * 1048576);
  activeQueries = 0;
  clear() {
    this.pages.clear();
    this.decoded.clear();
  }
}
export interface Source {
  readNamed?(key: string, bytes: number): Promise<Uint8Array>;
  readWhole?(
    key: string,
    range?: { offset: number; length: number; doc: number; first: number },
  ): Promise<{ data: Uint8Array; sha256?: string }>;
  read(key: string, offset: number, length: number): Promise<Uint8Array>;
  readPage?(
    key: string,
    offset: number,
    length: number,
    expectedSha256?: string,
  ): Promise<{ data: Uint8Array }>;
}
function packetGroups(refs: Ref[], adjacentPages = false) {
  const groups: { ref: Ref; entries: { ref: Ref; index: number }[] }[] = [];
  for (const entry of refs
    .map((ref, index) => ({ ref, index }))
    .sort((a, b) => a.ref[0] - b.ref[0] || a.ref[1] - b.ref[1])) {
    const group = groups.at(-1),
      end = entry.ref[1] + entry.ref[2];
    if (
      group &&
      group.ref[0] === entry.ref[0] &&
      (adjacentPages ? Math.floor(entry.ref[1] / PAGE) * PAGE : entry.ref[1]) <=
        (adjacentPages
          ? Math.ceil((group.ref[1] + group.ref[2]) / PAGE) * PAGE
          : group.ref[1] + group.ref[2] + PAGE) &&
      Math.max(group.ref[1] + group.ref[2], end) - group.ref[1] <= 8 * 1048576
    ) {
      group.ref[2] = Math.max(group.ref[1] + group.ref[2], end) - group.ref[1];
      group.entries.push(entry);
    } else groups.push({ ref: [...entry.ref], entries: [entry] });
  }
  return groups;
}
const EMPTY_PACKET = new Uint8Array(0);
export class Reader {
  /** Optional benchmark hook; no candidate scans or retained state in serving. */
  inspectCandidateBlocks?: (
    blocks: Branch[][],
    mask: Uint8Array,
    first: number,
  ) => void;
  private inline = new Map<number, { ref: Ref; data: Uint8Array }[]>();
  /** A validated dictionary shard can carry its own complete small postings. */
  seed(ref: Ref, data: Uint8Array) {
    if (this.retainPacket(ref, data))
      this.stats.inlinePostingBytes += data.length;
  }
  private retainPacket(ref: Ref, data: Uint8Array) {
    if (!ref[2] || ref[2] !== data.length) throw Error("Invalid seeded range");
    const spans = this.inline.get(ref[0]) ?? [];
    if (spans.some((s) => s.ref[1] === ref[1] && s.ref[2] === ref[2]))
      return false;
    spans.push({ ref: [...ref], data });
    this.inline.set(ref[0], spans);
    this.stats.retainedPacketBytes += data.length;
    return true;
  }
  private seeded(ref: Ref) {
    const span = this.inline
      .get(ref[0])
      ?.find(
        (s) => ref[1] >= s.ref[1] && ref[1] + ref[2] <= s.ref[1] + s.ref[2],
      );
    return span?.data.subarray(
      ref[1] - span.ref[1],
      ref[1] - span.ref[1] + ref[2],
    );
  }
  // I/O promises belong to their request context in workerd. Share validated
  // bytes across requests; deduplicate outstanding I/O within each request.
  pending = new Map<string, Promise<Uint8Array>>();
  io = new Semaphore(6);
  sharedWrites = new Set<Promise<void>>();
  sharedWriteBytes = 0;
  stats = {
    exactPhraseDiscoveryReads: 0,
    exactPhraseDiscoveryBytes: 0,
    exactPhraseDiscoveryWaves: 0,
    exactPhraseFilteredAlternatives: [] as {
      words: string[];
      candidates: number;
      bytes: number;
      occurrences: number;
      completeOccurrences: number;
      preferFiltered: boolean;
    }[],
    exactPhrasePlans: [] as {
      words: string[];
      anchor: string[];
      at: number;
      occurrences: number;
      bytes: number;
      gets: number;
      cost: number;
      alternativeCost: number;
      mode?: "membership" | "positions";
    }[],
    exactPhraseReads: 0,
    exactPhraseBytes: 0,
    exactPhraseOccurrences: 0,
    exactPhraseMatches: 0,
    peakExactPhraseBufferBytes: 0,
    peakExactPhraseWindows: 0,
    wordPositionIntegers: 0,
    wordPositionBlocks: 0,
    wordPositionBytes: 0,
    metadataFilterIOWaves: 0,
    metadataFilterCandidates: 0,
    metadataFilterRejected: 0,
    metadataFilterBlocks: 0,
    metadataFilterBytes: 0,
    inlinePostingBytes: 0,
    retainedPacketBytes: 0,
    termDirectoryRanges: 0,
    termDirectoryBytes: 0,
    termDirectoryMatches: 0,
    requests: 0,
    bytes: 0,
    sharedGets: 0,
    sharedPuts: 0,
    sharedBudgetBypasses: 0,
    memoryHits: 0,
    deduplicated: 0,
    stages: 0,
    scoreBlocksFetched: 0,
    scoreBlockVisits: 0,
    scoreBlocksDecoded: 0,
    scorePostingsDecoded: 0,
    scoreFrequencyIntegers: 0,
    scoreFetchWaves: 0,
    scoreIOWaves: 0,
    anchorIOWaves: 0,
    anchorUnigramCandidates: 0,
    anchorIntersectionCandidates: 0,
    membershipCandidates: 0,
    positionIOWaves: 0,
    positionBatchCount: 0,
    maxPositionFootprintBytes: 0,
    peakPositionNumericBytes: 0,
    peakPositionBufferBytes: 0,
    lazyScoreWindows: 0,
    eagerScoreWindows: 0,
    eagerScoreFetchWindows: 0,
    partialScoreRejected: 0,
    packetCopyBytes: 0,
    packetViewBytes: 0,
    decodedBytes: 0,
    repeatedDecodedBytes: 0,
    positionIntegers: 0,
    pairContextIntegers: 0,
    pairPositionChunks: 0,
    pairPositionBytes: 0,
    pairPositionProductsSkipped: 0,
    pairMembershipIntegers: 0,
    pairMembershipDecodedBytes: 0,
    pairMembershipRepeatedDecodedBytes: 0,
    commonPresenceIntegers: 0,
    commonPresenceDecodedBytes: 0,
    optionalReadAlternative: "",
    plannedPairPackets: 0,
    plannedPresenceLists: 0,
    estimatedPairCandidates: 0,
    pairReplanIOWaves: 0,
    pairReplanCandidatesBefore: 0,
    pairReplanCandidatesAfter: 0,
    forwardIntegers: 0,
    postings: 0,
    candidates: 0,
    skippedRanges: 0,
    metadataMs: 0,
    resultRequests: 0,
    resultBytes: 0,
    resultSharedGets: 0,
    resultMemoryHits: 0,
    candidatePackageBytes: 0,
    packageCandidates: 0,
    documentVerificationRanges: 0,
    documentVerificationBytes: 0,
    documentPresentationRanges: 0,
    documentPresentationBytes: 0,
    packageMatches: 0,
    packageFetchWaves: 0,
    packageIOWaves: 0,
    packagePipelineLoads: 0,
    packagePipelineWaits: 0,
    peakPackagePipelinePending: 0,
    packageMetadataFetchWaves: 0,
    oversizedPackageBatches: 0,
    peakPackageBatchBytes: 0,
    peakPackageNumericBytes: 0,
    peakPackagePositionBytes: 0,
    peakWinnerPackageBytes: 0,
    inflatedBytes: 0,
    repeatedInflatedBytes: 0,
    anchorBufferBytes: 0,
    peakActiveBufferBytes: 0,
    peakPendingSharedBytes: 0,
    coalescedReads: 0,
    coalescedExtraBytes: 0,
    prefetchWindows: 0,
    maxPrefetchFootprintBytes: 0,
    prefetchTransferBytes: 0,
    prefetchOriginBytes: 0,
    pairDirectoryRanges: 0,
    pairDirectoryBytes: 0,
    pairDirectoryMatches: 0,
  };
  seenDecoded = new Set<string>();
  private seenScoreBlocks = new Set<string>();
  seenInflated = new Set<string>();
  seenPackageSections = new Set<string>();
  pairDecoded = new Map<string, Uint8Array>();
  anchors = new Map<string, import("./pair-execution.js").PairAnchorEvidence>();
  constructor(
    readonly root: Pick<Root, "generation" | "objects" | "objectIds">,
    readonly source: Source,
    readonly memory = new Memory(),
    readonly shared?: SharedPages,
    readonly namespace = "default",
    readonly defer: (p: Promise<unknown>) => void = (p) => {
      void p.catch(() => {});
    },
    readonly sharedBudget = { remaining: 900 },
  ) {}
  private takeShared() {
    if (this.sharedBudget.remaining > 0) {
      this.sharedBudget.remaining--;
      return true;
    }
    this.stats.sharedBudgetBypasses++;
    return false;
  }
  key(ref: Ref) {
    return `${this.root.generation}:${ref.join(":")}`;
  }
  async page(object: number, page: number) {
    const o = objectAt(this.root, object);
    if (!o) throw Error("Invalid object");
    const offset = page * PAGE,
      length = Math.min(PAGE, o.size - offset),
      key = `${this.root.generation}/${this.namespace}/${object}/${page}`;
    if (length <= 0) throw Error("Invalid page");
    const hit = this.memory.pages.get(key);
    if (hit) {
      this.stats.memoryHits++;
      return hit;
    }
    const pending = this.pending.get(key);
    if (pending) {
      this.stats.deduplicated++;
      return pending;
    }
    const task = this.io.run(async () => {
      let data: Uint8Array | undefined,
        origin = false;
      if (this.shared && this.takeShared()) {
        this.stats.sharedGets++;
        data = await this.shared.get(key);
      }
      if (!data) {
        origin = true;
        this.stats.requests++;
        this.stats.bytes += length;
        const key = o.key ?? `${this.root.generation}/${o.name}`;
        if (this.source.readPage) {
          const result = await this.source.readPage(
            key,
            offset,
            length,
            o.sha256,
          );
          data = result.data;
        } else data = await this.source.read(key, offset, length);
      }
      if (data.length !== length) throw Error("Truncated immutable page");
      this.memory.pages.set(key, data, data.length);
      if (this.shared && origin && this.takeShared()) {
        // Cache writes retain their input until completion. Backpressure bounds
        // this separately from the page LRU, including concurrent fetches.
        while (this.sharedWriteBytes >= 2 * 1048576)
          await Promise.race(this.sharedWrites);
        this.stats.sharedPuts++;
        this.sharedWriteBytes += data.length;
        this.stats.peakPendingSharedBytes = Math.max(
          this.stats.peakPendingSharedBytes,
          this.sharedWriteBytes,
        );
        const size = data.length;
        const write = this.shared
          .put(key, data)
          .catch(() => {})
          .finally(() => {
            this.sharedWriteBytes -= size;
            this.sharedWrites.delete(write);
          });
        this.sharedWrites.add(write);
        this.defer(write);
      }
      return data;
    });
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }
  async read(ref: Ref) {
    const inline = this.seeded(ref);
    if (inline) return inline;
    const [object, offset, length] = ref,
      o = objectAt(this.root, object);
    if (
      !o ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 1 ||
      offset + length > o.size
    )
      throw Error("Invalid blob reference");
    const first = Math.floor(offset / PAGE),
      last = Math.floor((offset + length - 1) / PAGE);
    const parts = await Promise.all(
      Array.from({ length: last - first + 1 }, (_, i) =>
        this.page(object, first + i),
      ),
    );
    if (parts.length === 1)
      return parts[0].subarray(offset % PAGE, (offset % PAGE) + length);
    return concat(parts).subarray(offset % PAGE, (offset % PAGE) + length);
  }
  async many(refs: Ref[]) {
    this.stats.stages++;
    return Promise.all(refs.map((r) => this.read(r)));
  }
  private noteScores(refs: Ref[]) {
    for (const ref of refs) {
      this.stats.scoreBlockVisits++;
      const key = this.key(ref);
      if (!this.seenScoreBlocks.has(key)) {
        this.seenScoreBlocks.add(key);
        this.stats.scoreBlocksFetched++;
      }
    }
  }
  async scores(refs: Ref[], coalesce = false) {
    if (!refs.length) return [];
    this.noteScores(refs);
    this.stats.scoreFetchWaves++;
    const before = this.stats.requests + this.stats.sharedGets;
    const raw = await (coalesce ? this.packets(refs) : this.many(refs));
    if (this.stats.requests + this.stats.sharedGets > before)
      this.stats.scoreIOWaves++;
    return raw;
  }
  async prefetchScores(refs: Ref[]) {
    if (!refs.length) return;
    this.noteScores(refs);
    this.stats.scoreFetchWaves++;
    const before = this.stats.requests + this.stats.sharedGets;
    await this.prefetch(refs);
    if (this.stats.requests + this.stats.sharedGets > before)
      this.stats.scoreIOWaves++;
  }
  /** No I/O and no LRU mutation. Used only to price another score fetch wave. */
  resident(ref: Ref) {
    if (this.seeded(ref)) return true;
    const [object, offset, length] = ref;
    for (
      let page = Math.floor(offset / PAGE);
      page <= Math.floor((offset + length - 1) / PAGE);
      page++
    )
      if (
        !this.memory.pages.entries.has(
          `${this.root.generation}/${this.namespace}/${object}/${page}`,
        )
      )
        return false;
    return true;
  }
  /** A packet is a transfer unit, independent of the 256-KiB cache pages.
   * Fetch a contiguous miss span once, validate each page, and populate the
   * ordinary page cache. Cached pages inside that span may be read again to
   * avoid another GET. Their extra bytes are reported separately. */
  async packet(ref: Ref): Promise<Uint8Array> {
    const key = "packet:" + this.key(ref),
      pending = this.pending.get(key);
    if (pending) {
      this.stats.deduplicated++;
      return pending;
    }
    const task = this.readPacket(ref);
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }
  private async readPacket(ref: Ref, warmOnly = false): Promise<Uint8Array> {
    const inline = this.seeded(ref);
    if (inline) return warmOnly ? EMPTY_PACKET : inline;
    const [object, offset, length] = ref,
      descriptor = objectAt(this.root, object);
    if (
      !descriptor ||
      offset < 0 ||
      length < 1 ||
      offset + length > descriptor.size
    )
      throw Error("Invalid packet reference");
    if (length > 8 * 1048576) return this.read(ref);
    const pages = await this.packetPages(ref);
    return warmOnly
      ? EMPTY_PACKET
      : this.packetSlice(pages, offset % PAGE, length);
  }
  private packetPageReads = new Map<string, Promise<Uint8Array[]>>();
  private async packetPages(ref: Ref) {
    const key = this.key(ref),
      old = this.packetPageReads.get(key);
    if (old) {
      this.stats.deduplicated++;
      return old;
    }
    const task = this.loadPacketPages(ref);
    this.packetPageReads.set(key, task);
    try {
      return await task;
    } finally {
      this.packetPageReads.delete(key);
    }
  }
  private async loadPacketPages(ref: Ref): Promise<Uint8Array[]> {
    const [object, offset, length] = ref,
      descriptor = objectAt(this.root, object);
    if (
      !descriptor ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 1 ||
      offset + length > descriptor.size
    )
      throw Error("Invalid packet reference");
    const first = Math.floor(offset / PAGE),
      last = Math.floor((offset + length - 1) / PAGE),
      indices = Array.from({ length: last - first + 1 }, (_, i) => first + i),
      key = (page: number) =>
        `${this.root.generation}/${this.namespace}/${object}/${page}`;
    const pages = await Promise.all(
      indices.map(async (page) => {
        const k = key(page),
          hit = this.memory.pages.get(k);
        if (hit) {
          this.stats.memoryHits++;
          return hit;
        }
        const pending = this.pending.get(k);
        if (pending) {
          this.stats.deduplicated++;
          return pending;
        }
        if (this.shared && this.takeShared()) {
          this.stats.sharedGets++;
          const data = await this.io.run(() => this.shared!.get(k));
          if (data) {
            this.memory.pages.set(k, data, data.length);
            return data;
          }
        }
        return undefined;
      }),
    );
    const missing = indices.filter((_, i) => !pages[i]);
    if (missing.length) {
      const from = missing[0],
        to = missing.at(-1)!,
        start = from * PAGE,
        bytes = Math.min(descriptor.size, (to + 1) * PAGE) - start;
      this.stats.coalescedReads++;
      this.stats.requests++;
      this.stats.bytes += bytes;
      this.stats.coalescedExtraBytes += indices.reduce(
        (n, p, i) =>
          n + (p >= from && p <= to && pages[i] ? pages[i]!.length : 0),
        0,
      );
      const task = this.io.run(async () => {
        const data = await this.source.read(
          descriptor.key ?? `${this.root.generation}/${descriptor.name}`,
          start,
          bytes,
        );
        if (data.length !== bytes) throw Error("Truncated packet range");
        const result: Uint8Array[] = [];
        for (let page = from; page <= to; page++) {
          const raw = data.subarray(
            (page - from) * PAGE,
            Math.min(data.length, (page - from + 1) * PAGE),
          );
          // Each page owns its storage: evicting one page must not retain an
          // entire multi-megabyte range through another page's subarray.
          const owned = Uint8Array.from(raw),
            k = key(page);
          result.push(owned);
          this.memory.pages.set(k, owned, owned.length);
          if (this.shared && this.takeShared()) {
            while (this.sharedWriteBytes >= 2 * 1048576)
              await Promise.race(this.sharedWrites);
            this.stats.sharedPuts++;
            this.sharedWriteBytes += owned.length;
            this.stats.peakPendingSharedBytes = Math.max(
              this.stats.peakPendingSharedBytes,
              this.sharedWriteBytes,
            );
            const write = this.shared
              .put(k, owned)
              .catch(() => {})
              .finally(() => {
                this.sharedWriteBytes -= owned.length;
                this.sharedWrites.delete(write);
              });
            this.sharedWrites.add(write);
            this.defer(write);
          }
        }
        return result;
      });
      for (let page = from; page <= to; page++) {
        const p = task.then((data) => data[page - from]);
        void p.catch(() => {});
        this.pending.set(key(page), p);
      }
      try {
        const fetched = await task;
        for (let page = from; page <= to; page++)
          pages[page - first] = fetched[page - from];
      } finally {
        for (let page = from; page <= to; page++)
          this.pending.delete(key(page));
      }
    }
    return pages as Uint8Array[];
  }
  /** Transfer groups retain their independently owned pages until all requested
   * block views are made, even when the group is larger than the page LRU. */
  private packetSlice(pages: Uint8Array[], offset: number, length: number) {
    const first = Math.floor(offset / PAGE),
      at = offset % PAGE;
    if (at + length <= pages[first].length) {
      this.stats.packetViewBytes += length;
      return pages[first].subarray(at, at + length);
    }
    this.stats.packetCopyBytes += length;
    const data = new Uint8Array(length);
    let written = 0;
    for (let p = first; written < length; p++) {
      const start = p === first ? at : 0;
      const n = Math.min(length - written, pages[p].length - start);
      data.set(pages[p].subarray(start, start + n), written);
      written += n;
    }
    return data;
  }
  async packets(refs: Ref[], adjacentPages = false) {
    this.stats.stages++;
    const result: Uint8Array[] = new Array(refs.length);
    const pending: Ref[] = [],
      indices: number[] = [];
    refs.forEach((ref, i) => {
      const inline = this.seeded(ref);
      if (inline) result[i] = inline;
      else {
        pending.push(ref);
        indices.push(i);
      }
    });
    const groups = packetGroups(pending, adjacentPages);
    await Promise.all(
      groups.map(async (group) => {
        const descriptor = objectAt(this.root, group.ref[0]);
        if (descriptor && group.ref[2] <= 8 * 1048576) {
          const pages = await this.packetPages(group.ref),
            first = Math.floor(group.ref[1] / PAGE) * PAGE;
          for (const { ref, index } of group.entries)
            result[indices[index]] = this.packetSlice(
              pages,
              ref[1] - first,
              ref[2],
            );
        } else {
          const data = await this.packet(group.ref);
          for (const { ref, index } of group.entries)
            result[indices[index]] = data.subarray(
              ref[1] - group.ref[1],
              ref[1] - group.ref[1] + ref[2],
            );
        }
      }),
    );
    return result;
  }
  /** Complete immutable lists have stable cache identities of their own. Avoid
   * copying a complete list into pages and then assembling it again. Sparse
   * block access continues to use independently cached physical pages. */
  async completePackets(refs: Ref[]) {
    this.stats.stages++;
    return Promise.all(
      refs.map(async (ref) => {
        if (this.resident(ref)) return this.packet(ref);
        const object = objectAt(this.root, ref[0]);
        if (!object) throw Error("Invalid complete packet object");
        const key = object.key ?? `${this.root.generation}/${object.name}`;
        if (
          !object.key ||
          !this.source.readNamed ||
          !/^[a-f0-9]{64}\/plan-\d+\.bin$/.test(key)
        )
          return this.packet(ref);
        if (
          !Number.isSafeInteger(ref[1]) ||
          !Number.isSafeInteger(ref[2]) ||
          ref[1] < 0 ||
          ref[2] < 1 ||
          ref[1] + ref[2] > object.size
        )
          throw Error("Invalid complete packet range");
        const data = await this.named(`${key}@${ref[1]}`, ref[2]);
        // A later block continuation can use subranges of an already-read
        // anchor without fetching its pages again. Retention is request-local.
        this.retainPacket(ref, data);
        return data;
      }),
    );
  }
  /** Conservative physical transfer footprint, including page alignment and
   * the same range coalescing used by packets(). No bytes are decoded here. */
  packetFootprint(refs: Ref[]) {
    return packetGroups(refs.filter((r) => !this.seeded(r))).reduce(
      (bytes, { ref: [, offset, length] }) =>
        bytes +
        (Math.ceil((offset + length) / PAGE) - Math.floor(offset / PAGE)) *
          PAGE,
      0,
    );
  }
  /** Positions merge only overlapping/adjacent pages, without filling gaps.
   * This is also the retained backing-store footprint used by the scheduler. */
  positionFootprint(refs: Ref[]) {
    return packetGroups(
      refs.filter((r) => !this.seeded(r)),
      true,
    ).reduce(
      (n, { ref: [object, offset, length] }) =>
        n +
        Math.min(
          objectAt(this.root, object)!.size,
          Math.ceil((offset + length) / PAGE) * PAGE,
        ) -
        Math.floor(offset / PAGE) * PAGE,
      0,
    );
  }
  async positions(refs: Ref[]) {
    if (!refs.length) return [];
    this.stats.wordPositionBlocks += refs.length;
    this.stats.wordPositionBytes += refs.reduce((n, r) => n + r[2], 0);
    const before = this.stats.requests + this.stats.sharedGets;
    const raw = await this.packets(refs, true);
    if (this.stats.requests + this.stats.sharedGets > before)
      this.stats.positionIOWaves++;
    return raw;
  }
  async prefetch(refs: Ref[]) {
    this.stats.stages++;
    await Promise.all(
      packetGroups(refs.filter((r) => !this.seeded(r))).map(({ ref }) =>
        this.readPacket(ref, true),
      ),
    );
  }
  /** Whole immutable pair packets use the same bounded cache and I/O slots as
   * posting pages. The bundled router supplies their exact length. */
  async named(address: string, length: number) {
    if (!this.source.readNamed || length < 1 || length > 32 * 1048576)
      throw Error("Invalid named packet source");
    const key = `${this.root.generation}/${this.namespace}/named/${address}:${length}`;
    const validate = (data: Uint8Array) => {
      if (data.length !== length) throw Error("Truncated named packet");
      return data;
    };
    const cached = this.memory.pages.get(key);
    if (cached) {
      this.stats.memoryHits++;
      return cached;
    }
    const old = this.pending.get(key);
    if (old) {
      this.stats.deduplicated++;
      return old;
    }
    const task = this.io.run(async () => {
      if (this.shared && this.takeShared()) {
        this.stats.sharedGets++;
        const cached = await this.shared.get(key);
        if (cached) {
          validate(cached);
          this.memory.pages.set(key, cached, cached.length);
          return cached;
        }
      }
      const data = validate(await this.source.readNamed!(address, length));
      this.stats.requests++;
      this.stats.bytes += data.length;
      this.memory.pages.set(key, data, data.length);
      if (this.shared && this.takeShared()) {
        while (this.sharedWriteBytes >= 2 * 1048576)
          await Promise.race(this.sharedWrites);
        this.stats.sharedPuts++;
        this.sharedWriteBytes += data.length;
        this.stats.peakPendingSharedBytes = Math.max(
          this.stats.peakPendingSharedBytes,
          this.sharedWriteBytes,
        );
        const write = this.shared
          .put(key, data)
          .catch(() => {})
          .finally(() => {
            this.sharedWriteBytes -= data.length;
            this.sharedWrites.delete(write);
          });
        this.sharedWrites.add(write);
        this.defer(write);
      }
      return data;
    });
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }
  namedResident(address: string, length: number) {
    return this.memory.pages.entries.has(
      `${this.root.generation}/${this.namespace}/named/${address}:${length}`,
    );
  }
  async document(
    generation: string,
    doc: number,
    locator?: {
      key: string;
      offset: number;
      length: number;
      first: number;
      prefixLength?: number;
    },
    wanted?: Set<number>,
    presentation = false,
  ) {
    if (
      !Number.isInteger(doc) ||
      doc < 0 ||
      !/^[a-f0-9]{64}$/.test(generation) ||
      !this.source.readWhole
    )
      throw Error("Invalid document package source");
    const address = locator?.key ?? `${generation}/plan-${doc}.bin`,
      key = `${this.root.generation}/${this.namespace}/whole/${generation}/${doc}`;
    const observe: NonNullable<
      ConstructorParameters<typeof DocumentPackage>[2]
    > = (kind, section, n) => {
      const id = `${address}:${doc}:${kind}:${section}`;
      if (kind === "tokens") this.stats.forwardIntegers += n;
      else if (kind === "decoded" || kind === "positions") {
        if (kind === "positions") this.stats.positionIntegers += n / 4;
        this.stats.decodedBytes += n;
        if (this.seenPackageSections.has(id))
          this.stats.repeatedDecodedBytes += n;
      } else {
        this.stats.inflatedBytes += n;
        if (this.seenPackageSections.has(id))
          this.stats.repeatedInflatedBytes += n;
      }
      this.seenPackageSections.add(id);
    };
    const decoded = (raw: Uint8Array) => new DocumentPackage(raw, doc, observe);
    if (locator?.prefixLength !== undefined) {
      // A small winner can finish in one read. Candidate verification never
      // opts into this: its prefix remains strictly numeric.
      const prefix =
        presentation && locator.length <= 65536
          ? locator.length
          : locator.prefixLength;
      if (
        !Number.isSafeInteger(prefix) ||
        prefix < 64 ||
        prefix > locator.length
      )
        throw Error("Invalid verification prefix");
      const prefixBytes = await this.named(
          `${address}@${locator.offset}`,
          prefix,
        ),
        verificationEnd = new DataView(
          prefixBytes.buffer,
          prefixBytes.byteOffset,
          prefixBytes.byteLength,
        ).getUint32(16, true);
      this.stats.documentVerificationRanges++;
      this.stats.documentVerificationBytes += Math.min(prefix, verificationEnd);
      if (prefix > verificationEnd) {
        this.stats.documentPresentationRanges++;
        this.stats.documentPresentationBytes += prefix - verificationEnd;
      }
      const read = (at: number, n: number) => {
        if (at + n <= verificationEnd) {
          this.stats.documentVerificationRanges++;
          this.stats.documentVerificationBytes += n;
        } else {
          this.stats.documentPresentationRanges++;
          this.stats.documentPresentationBytes += n;
        }
        return this.named(`${address}@${locator.offset + at}`, n);
      };
      const pkg = new DocumentPackage(prefixBytes, doc, observe, read);
      await pkg.prepare(wanted);
      return pkg;
    }
    let bytes = this.memory.pages.get(key);
    if (bytes) {
      this.stats.memoryHits++;
      return decoded(bytes);
    }
    const old = this.pending.get(key);
    if (old) {
      this.stats.deduplicated++;
      return decoded(await old);
    }
    const task = this.io.run(async () => {
      if (this.shared && this.takeShared()) {
        this.stats.sharedGets++;
        const data = await this.shared.get(key);
        if (data) {
          this.memory.pages.set(key, data, data.length);
          return data;
        }
      }
      const result = await this.source.readWhole!(
        address,
        locator ? { ...locator, doc } : undefined,
      );
      this.stats.requests++;
      this.stats.bytes += result.data.length;
      const digest = result.sha256
        ? [
            ...new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                result.data as BufferSource,
              ),
            ),
          ]
            .map((n) => n.toString(16).padStart(2, "0"))
            .join("")
        : undefined;
      if (result.sha256 && digest !== result.sha256)
        throw Error("Document package digest mismatch");
      if (locator && result.data.length !== locator.length)
        throw Error("Truncated document package");
      this.memory.pages.set(key, result.data, result.data.length);
      if (
        this.shared &&
        result.data.length <= 4 * 1048576 &&
        this.takeShared()
      ) {
        while (this.sharedWriteBytes >= 2 * 1048576)
          await Promise.race(this.sharedWrites);
        this.stats.sharedPuts++;
        this.sharedWriteBytes += result.data.length;
        this.stats.peakPendingSharedBytes = Math.max(
          this.stats.peakPendingSharedBytes,
          this.sharedWriteBytes,
        );
        const write = this.shared
          .put(key, result.data)
          .catch(() => {})
          .finally(() => {
            this.sharedWriteBytes -= result.data.length;
            this.sharedWrites.delete(write);
          });
        this.sharedWrites.add(write);
        this.defer(write);
      }
      return result.data;
    });
    this.pending.set(key, task);
    try {
      bytes = await task;
      return decoded(bytes);
    } finally {
      this.pending.delete(key);
    }
  }
  async load<T>(
    ref: Ref,
    decode: (data: Uint8Array) => T,
    charge?: number,
  ): Promise<T> {
    const old = this.memory.decoded.get(this.key(ref)) as T | undefined;
    if (old) {
      this.stats.memoryHits++;
      return old;
    }
    return this.decoded(ref, await this.read(ref), decode, charge);
  }
  decoded<T>(
    ref: Ref,
    data: Uint8Array,
    decode: (b: Uint8Array) => T,
    charge = data.length * 2,
    tag = "",
  ): T {
    const key = tag + this.key(ref),
      old = this.memory.decoded.get(key) as T | undefined;
    if (old) return old;
    this.observeDecoded(ref, data.length);
    const value = decode(data);
    this.memory.decoded.set(key, value, charge);
    return value;
  }
  observeDecoded(ref: Ref, bytes: number) {
    this.stats.decodedBytes += bytes;
    const address = `${ref[0]}:${ref[1]}`;
    if (this.seenDecoded.has(address)) this.stats.repeatedDecodedBytes += bytes;
    this.seenDecoded.add(address);
  }
  async branches(ref: Ref) {
    return this.load(ref, decodeBranches, ref[2] * 4);
  }
  async json(ref: Ref) {
    const key = "text:" + this.key(ref),
      old = this.memory.decoded.get(key);
    if (old) return old as any;
    const raw = new Response(
      (await this.read(ref)) as BodyInit,
    ).body!.pipeThrough(new DecompressionStream("gzip"));
    const text = await new Response(raw).text();
    if (text.length > 8 * 1048576) throw Error("Oversized text record");
    const address = `${ref[0]}:${ref[1]}`;
    this.stats.inflatedBytes += text.length * 2;
    if (this.seenInflated.has(address))
      this.stats.repeatedInflatedBytes += text.length * 2;
    this.seenInflated.add(address);
    const value = JSON.parse(text);
    this.memory.decoded.set(key, value, text.length * 3);
    return value;
  }
}
