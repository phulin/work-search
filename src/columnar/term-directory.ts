import { concat, type Term, type Ref, u32, view, refAt } from "./format.js";
import { Lru, Semaphore, type Reader } from "./storage.js";
import { TermShard } from "./term-shard.js";
export interface DirectoryTerm extends Term {
  bodyOccurrences: number;
  titleOccurrences: number;
  frequencies: Ref;
  positional: Ref;
  frequencyParts?: Ref[];
  positionalParts?: Ref[];
  embedded?: Uint8Array;
}
/** Conservative software accounting, not a claim about native heap size. The
 * compressed/raw byte count alone omits maps, strings, branch records and refs. */
export function directoryRetainedBytes(entries: Map<string, DirectoryTerm>) {
  let bytes = 0;
  for (const [word, term] of entries)
    bytes +=
      1024 +
      word.length * 2 +
      (term.embedded?.length ?? 0) +
      ((term.frequencyParts?.length ?? 0) +
        (term.positionalParts?.length ?? 0)) *
        64;
  return bytes;
}
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
function integer(out: number[], value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw Error("Invalid directory integer");
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    out.push(byte | (value ? 128 : 0));
  } while (value);
}
function take(data: Uint8Array, cursor: { at: number }) {
  let value = 0,
    scale = 1;
  for (let i = 0; i < 8; i++) {
    if (cursor.at >= data.length) throw Error("Truncated directory integer");
    const byte = data[cursor.at++];
    value += (byte & 127) * scale;
    if (!Number.isSafeInteger(value)) throw Error("Directory integer overflow");
    if (!(byte & 128)) return value;
    scale *= 128;
  }
  throw Error("Invalid directory integer");
}
/** Encoding is independent of transport compression. Front coding retains exact
 * UTF-8 bytes; strings are reconstructed before JavaScript lexical comparisons. */
function signed(out: number[], value: number) {
  integer(out, value < 0 ? -value * 2 - 1 : value * 2);
}
function signedTake(data: Uint8Array, cursor: { at: number }) {
  const n = take(data, cursor);
  return n % 2 ? -(n + 1) / 2 : n / 2;
}
export function encodeDirectoryBlock(entries: [string, DirectoryTerm][]) {
  const parts: Uint8Array[] = [u32([entries.length])];
  let previous = new Uint8Array(0),
    last: string | undefined,
    lastId = 0;
  const previousRefs: Ref[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const [name, term] of entries) {
    if (last !== undefined && last >= name)
      throw Error("Unsorted term directory");
    const word = encoder.encode(name);
    let prefix = 0;
    while (
      prefix < previous.length &&
      prefix < word.length &&
      previous[prefix] === word[prefix]
    )
      prefix++;
    const header: number[] = [];
    integer(header, prefix);
    integer(header, word.length - prefix);
    signed(header, term.id - lastId);
    for (const n of [
      term.df,
      term.bodyOccurrences,
      term.titleOccurrences,
      term.tree.height,
    ])
      integer(header, n);
    if (term.tree.height) {
      integer(header, term.tree.first);
      integer(header, term.tree.last - term.tree.first);
    }
    parts.push(Uint8Array.from(header), word.subarray(prefix));
    // Scores stay float64 in their scoring stream. Tiny-list upper bounds are
    // derived conservatively from BM25 rather than duplicating each maximum.
    if (term.tree.height) {
      const bounds = new Uint8Array(16),
        v = view(bounds);
      v.setFloat64(0, term.tree.b, true);
      v.setFloat64(8, term.tree.t, true);
      parts.push(bounds);
    }
    const refs: number[] = [];
    const ref = (r: Ref, j: number) => {
      signed(refs, r[0] - previousRefs[j][0]);
      signed(refs, r[1] - previousRefs[j][1]);
      integer(refs, r[2]);
      previousRefs[j] = r;
    };
    ref(term.tree.score, 0);
    ref(term.tree.positions, 1);
    const custom =
      term.tree.height !== 0 ||
      term.frequencies.some((n, i) => n !== term.tree.score[i]) ||
      term.positional.some((n, i) => n !== term.tree.positions[i]);
    integer(
      refs,
      +custom |
        (term.frequencyParts?.length ? 2 : 0) |
        (term.positionalParts?.length ? 4 : 0),
    );
    if (custom) {
      ref(term.frequencies, 2);
      ref(term.positional, 3);
    }
    for (const [parts, j] of [
      [term.frequencyParts, 2],
      [term.positionalParts, 3],
    ] as const)
      if (parts?.length) {
        integer(refs, parts.length);
        for (const part of parts) ref(part, j);
      }
    integer(refs, term.embedded?.length ?? 0);
    parts.push(Uint8Array.from(refs));
    if (term.embedded) parts.push(term.embedded);
    previous = word;
    last = name;
    lastId = term.id;
  }
  return concat(parts);
}
export function decodeDirectoryBlock(
  data: Uint8Array,
  documents = Number.MAX_SAFE_INTEGER,
) {
  if (data.length < 4) throw Error("Truncated directory block");
  const count = view(data).getUint32(0, true),
    cursor = { at: 4 },
    result = new Map<string, DirectoryTerm>();
  let previous = new Uint8Array(0),
    last: string | undefined,
    lastId = 0;
  const previousRefs: Ref[] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  if (count > 4096) throw Error("Oversized directory block");
  for (let i = 0; i < count; i++) {
    const prefix = take(data, cursor),
      suffix = take(data, cursor),
      id = lastId + signedTake(data, cursor),
      df = take(data, cursor),
      bodyOccurrences = take(data, cursor),
      titleOccurrences = take(data, cursor),
      height = take(data, cursor),
      first = height ? take(data, cursor) : 0,
      lastDoc = height
        ? first + take(data, cursor)
        : Math.min(0xffffffff, documents - 1);
    if (
      prefix > previous.length ||
      cursor.at + suffix > data.length ||
      df > documents
    )
      throw Error("Invalid term directory span");
    const word = new Uint8Array(prefix + suffix);
    word.set(previous.subarray(0, prefix));
    word.set(data.subarray(cursor.at, cursor.at + suffix), prefix);
    cursor.at += suffix;
    const name = decoder.decode(word);
    let b =
        Math.log(1 + (documents - df + 0.5) / (df + 0.5)) *
        2.2 *
        (1 + Number.EPSILON * 64),
      t = b;
    if (height) {
      if (cursor.at + 16 > data.length)
        throw Error("Truncated directory bounds");
      const v = view(data);
      b = v.getFloat64(cursor.at, true);
      t = v.getFloat64(cursor.at + 8, true);
      cursor.at += 16;
    }
    const ref = (j: number): Ref => {
      const r: Ref = [
        previousRefs[j][0] + signedTake(data, cursor),
        previousRefs[j][1] + signedTake(data, cursor),
        take(data, cursor),
      ];
      if (r.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffffffff))
        throw Error("Invalid directory reference");
      previousRefs[j] = r;
      return r;
    };
    const score = ref(0),
      positions = ref(1),
      custom = take(data, cursor);
    if (custom > 7) throw Error("Invalid packet flag");
    const frequencies = custom & 1 ? ref(2) : score,
      positional = custom & 1 ? ref(3) : positions;
    const parts = (j: number) => {
        const n = take(data, cursor);
        if (n > 4096) throw Error("Oversized packet span list");
        return Array.from({ length: n }, () => ref(j));
      },
      frequencyParts = custom & 2 ? parts(2) : undefined,
      positionalParts = custom & 4 ? parts(3) : undefined,
      n = take(data, cursor);
    if (
      cursor.at + n > data.length ||
      !Number.isInteger(id) ||
      id < 0 ||
      id > 0xffffffff ||
      !df ||
      (last !== undefined && last >= name)
    )
      throw Error("Invalid term directory entry");
    const embedded = n ? data.slice(cursor.at, cursor.at + n) : undefined;
    cursor.at += n;
    result.set(name, {
      id,
      df,
      tree: {
        first,
        last: lastDoc,
        count: df,
        height,
        b,
        t,
        score,
        positions,
        locators: [0, 0, 0],
      },
      frequencies,
      positional,
      bodyOccurrences,
      titleOccurrences,
      embedded,
      ...(frequencyParts ? { frequencyParts } : {}),
      ...(positionalParts ? { positionalParts } : {}),
    });
    previous = word;
    last = name;
    lastId = id;
  }
  if (cursor.at !== data.length) throw Error("Trailing term directory bytes");
  return result;
}
export interface DirectoryBlock {
  first: string;
  count: number;
  data: Uint8Array;
}
/** No term objects or all-vocabulary string table are created at startup. The
 * restart directory and compressed binary blocks stay in the bundled buffer. */
export function assembleTermDirectory(blocks: DirectoryBlock[]) {
  const keys = blocks.map((b) => encoder.encode(b.first)),
    keyBytes = keys.reduce((n, b) => n + b.length, 0),
    header = new Uint8Array(16 + blocks.length * 20),
    v = view(header);
  v.setUint32(0, 0x32445443, true);
  v.setUint32(
    4,
    blocks.reduce((n, b) => n + b.count, 0),
    true,
  );
  v.setUint32(8, blocks.length, true);
  v.setUint32(12, header.length + keyBytes, true);
  let keyAt = header.length,
    at = header.length + keyBytes,
    ordinal = 0;
  blocks.forEach((b, i) => {
    if (!b.count || (i && blocks[i - 1].first >= b.first))
      throw Error("Unsorted directory blocks");
    for (const [j, n] of [
      keyAt,
      keys[i].length,
      at,
      b.data.length,
      ordinal,
    ].entries())
      v.setUint32(16 + i * 20 + j * 4, n, true);
    keyAt += keys[i].length;
    at += b.data.length;
    ordinal += b.count;
  });
  return concat([header, ...keys, ...blocks.map((b) => b.data)]);
}
/** The hot directory and compact cold-shard routing table share one bundle.
 * Cold routing records contain a direct Ref, never a remote discovery tree. */
export function assembleTieredDirectory(hot: Uint8Array, cold: Uint8Array) {
  if (
    view(hot).getUint32(0, true) !== 0x32445443 ||
    view(cold).getUint32(0, true) !== 0x32445443
  )
    throw Error("Invalid tiered directory sections");
  return concat([
    u32([
      0x33445443,
      view(hot).getUint32(4, true) + view(cold).getUint32(4, true),
      hot.length,
      cold.length,
    ]),
    hot,
    cold,
  ]);
}
export class TermDirectory {
  readonly bytes: Uint8Array;
  readonly data: DataView;
  readonly terms: number;
  readonly bundledTerms: number;
  readonly blocks: number;
  private cold?: TermDirectory;
  private decoded = new Lru<Map<string, DirectoryTerm>>(2 * 1048576);
  constructor(
    bundled: Uint8Array,
    readonly documents = Number.MAX_SAFE_INTEGER,
  ) {
    let total: number | undefined;
    let bytes = bundled;
    if (bytes.length >= 16 && view(bytes).getUint32(0, true) === 0x33445443) {
      const v = view(bytes),
        hot = v.getUint32(8, true),
        cold = v.getUint32(12, true);
      total = v.getUint32(4, true);
      if (16 + hot + cold !== bytes.length)
        throw Error("Invalid tiered directory size");
      this.cold = new TermDirectory(bytes.subarray(16 + hot), documents);
      bytes = bytes.subarray(16, 16 + hot);
      if (total !== view(bytes).getUint32(4, true) + this.cold.terms)
        throw Error("Tiered vocabulary coverage mismatch");
      for (let i = 0; i < this.cold.blocks; i++)
        if (this.cold.block(i).length !== 12)
          throw Error("Invalid cold routing record");
    }
    this.bytes = bytes;
    this.data = view(bytes);
    if (bytes.length < 16 || this.data.getUint32(0, true) !== 0x32445443)
      throw Error("Invalid term directory");
    this.terms = total ?? this.data.getUint32(4, true);
    this.bundledTerms = this.data.getUint32(4, true);
    this.blocks = this.data.getUint32(8, true);
    if (16 + this.blocks * 20 > bytes.length)
      throw Error("Truncated term directory");
    let previous = 16 + this.blocks * 20;
    for (let i = 0; i < this.blocks; i++) {
      const p = 16 + i * 20,
        k = this.data.getUint32(p, true),
        kl = this.data.getUint32(p + 4, true),
        at = this.data.getUint32(p + 8, true),
        n = this.data.getUint32(p + 12, true);
      if (
        k < previous ||
        k + kl > this.data.getUint32(12, true) ||
        at < this.data.getUint32(12, true) ||
        at + n > bytes.length
      )
        throw Error("Invalid directory address");
      previous = k + kl;
    }
  }
  clear() {
    this.decoded.clear();
    this.cold?.clear();
  }
  /** Corpus accelerators select their vocabulary from the highest-DF tier.
   * Iteration holds one decoded metadata group rather than a vocabulary map. */
  async *bundledEntries() {
    for (let i = 0; i < this.blocks; i++) {
      const raw = new Uint8Array(
        await new Response(
          new Response(this.block(i) as BodyInit).body!.pipeThrough(
            new DecompressionStream("gzip"),
          ),
        ).arrayBuffer(),
      );
      yield* decodeDirectoryBlock(raw, this.documents);
    }
  }
  /** Offline streaming enumeration, holding one cold shard at a time. */
  async *allEntries(reader: Reader) {
    yield* this.bundledEntries();
    if (this.cold)
      for (let i = 0; i < this.cold.blocks; i++) {
        const ref = refAt(view(this.cold.block(i)), 0),
          [raw] = await reader.packets([ref]),
          shard = await TermShard.decode(raw, this.documents);
        yield* shard.entries;
      }
  }
  private first(i: number) {
    const p = 16 + i * 20;
    return decoder.decode(
      this.bytes.subarray(
        this.data.getUint32(p, true),
        this.data.getUint32(p, true) + this.data.getUint32(p + 4, true),
      ),
    );
  }
  private block(i: number) {
    const p = 16 + i * 20,
      at = this.data.getUint32(p + 8, true),
      n = this.data.getUint32(p + 12, true);
    return this.bytes.subarray(at, at + n);
  }
  private route(name: string) {
    let lo = 0,
      hi = this.blocks;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (this.first(m) <= name) lo = m + 1;
      else hi = m;
    }
    return lo - 1;
  }
  lookupBundled(names: string[]) {
    return this.lookup(names, undefined, true);
  }
  async lookup(names: string[], reader?: Reader, bundledOnly = false) {
    // Decompression belongs to this request. A cancelled owner must not leave
    // later requests waiting on its unfinished streams or semaphore slots.
    const decoding = new Semaphore(2),
      wanted = new Map<number, string[]>();
    for (const name of names) {
      const i = this.route(name);
      if (i >= 0) {
        const a = wanted.get(i) ?? [];
        a.push(name);
        wanted.set(i, a);
      }
    }
    const found = new Map<string, DirectoryTerm>();
    await Promise.all(
      [...wanted].map(([i, ns]) =>
        decoding.run(async () => {
          const key = String(i);
          let entries = this.decoded.get(key);
          if (!entries) {
            const p = 16 + i * 20,
              at = this.data.getUint32(p + 8, true),
              n = this.data.getUint32(p + 12, true),
              raw = new Uint8Array(
                await new Response(
                  new Response(
                    this.bytes.subarray(at, at + n) as BodyInit,
                  ).body!.pipeThrough(new DecompressionStream("gzip")),
                ).arrayBuffer(),
              );
            entries = decodeDirectoryBlock(raw, this.documents);
            this.decoded.set(key, entries, directoryRetainedBytes(entries));
          }
          for (const name of ns) {
            const term = entries.get(name);
            if (term) found.set(name, term);
          }
        }),
      ),
    );
    if (bundledOnly) return found;
    const remote = new Map<number, string[]>();
    if (this.cold)
      for (const name of new Set(names)) {
        if (found.has(name)) continue;
        const i = this.cold.route(name);
        if (i >= 0) {
          const wanted = remote.get(i) ?? [];
          wanted.push(name);
          remote.set(i, wanted);
        }
      }
    if (remote.size) {
      if (!reader) throw Error("Cold term lookup requires a query reader");
      const shards = [...remote].map(([i, names]) => ({
          names,
          ref: refAt(view(this.cold!.block(i)), 0),
        })),
        decoded = new Map<string, TermShard>(),
        misses = shards.filter(({ ref }) => {
          const key = reader.key(ref),
            cached = reader.memory.decoded.get("term-shard:" + key) as
              TermShard | undefined;
          if (cached) decoded.set(key, cached);
          return !cached;
        }),
        raw = await reader.packets(misses.map((s) => s.ref));
      reader.stats.termDirectoryRanges += misses.length;
      reader.stats.termDirectoryBytes += raw.reduce((n, r) => n + r.length, 0);
      for (let i = 0; i < misses.length; i++) {
        const shard = await TermShard.decode(raw[i], this.documents),
          key = reader.key(misses[i].ref);
        decoded.set(key, shard);
        reader.memory.decoded.set("term-shard:" + key, shard, shard.bytes);
      }
      for (const { ref, names } of shards) {
        const key = reader.key(ref),
          shard = decoded.get(key);
        // Keep the local result above: an oversized shard need not enter the LRU.
        if (!shard) throw Error("Term shard was evicted during lookup");
        shard.seed(reader, names);
        for (const name of names) {
          const term = shard.entries.get(name);
          if (term) {
            found.set(name, term);
            reader.stats.termDirectoryMatches++;
          }
        }
      }
    }
    return found;
  }
}
