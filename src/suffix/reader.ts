import { Semaphore, Lru } from "../columnar/storage.js";
import {
  PREFIX_WORDS,
  canonicalBit,
  type SuffixBlock,
  type SuffixColumn,
  type SuffixManifest,
} from "./format.js";
import { comparePhrase, decodeSuffixKeys } from "./keys.js";
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
  };
  private slots = new Semaphore(6);
  private cache = new Lru<Uint8Array>(8 * 1048576);
  private pending = new Map<string, Promise<Uint8Array>>();
  constructor(
    readonly manifest: SuffixManifest,
    readonly source: SuffixRead,
  ) {
    if (manifest.format !== "word-suffix-1" || manifest.fixed.titleBoost !== 2)
      throw Error("Invalid suffix manifest");
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
  async column(block: SuffixBlock, name: SuffixColumn) {
    const ref = block.columns[name];
    if (!ref) throw Error("Missing suffix column");
    return this.read(name, ref.offset, ref.length);
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
  ): AsyncGenerator<SuffixBatch> {
    // Fixed batches bound decoded bytes independently of total interval size.
    for (let i = 0; i < interval.blocks.length; i += 16) {
      const selected = interval.blocks.slice(i, i + 16).filter((b) => {
        if (!admit || admit(b)) return true;
        this.stats.skippedBlocks++;
        return false;
      });
      if (!selected.length) continue;
      this.stats.scanBatches++;
      const batches = await Promise.all(
        selected.map(async (block) => ({
          block,
          first: Math.max(0, interval.first - block.first),
          end: Math.min(block.count, interval.end - block.first),
          columns: Object.fromEntries(
            await Promise.all(
              columns.map(async (n) => [n, await this.column(block, n)]),
            ),
          ),
        })),
      );
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
