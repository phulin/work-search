import { sourceVerifier } from "./source-identity.js";
import { addDisplaySeeds } from "./display.js";
import { addMicroPlans } from "./micro.js";
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, mkdir, open, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { jsonLines } from "../builder/jsonl.js";
import { build as buildSource } from "../builder/build.js";
import { BinaryIndex, LOCAL, type Entry } from "../format/index.js";
import { FileStorage } from "../storage/filesystem.js";
import {
  decodeDirectory,
  directoryLength,
  BLOCK_SIZE,
} from "../format/blocks.js";
import { decodeBlockInto } from "../format/decode-block.js";
import {
  postingPositions,
  type DecodedPostings,
  encoder,
} from "../format/codec.js";
import { loadPosting, type Read } from "../query/load.js";
import { bm25 } from "../query/engine.js";
import { SearchRuntime } from "../query/runtime.js";
import { PagePacker } from "./pack.js";
import {
  TILE_DOCS,
  CHUNK_TOKENS,
  MAX_RAW,
  encodeRows,
  encodeTerm,
  encodeDictionary,
  encodeRoot,
  type Row,
  type Term,
  type Block,
  type Address,
  type Root,
} from "./format.js";
export interface GlobalBuildOptions {
  input: string;
  out: string;
  source?: string;
  pageBytes?: number;
  budgets?: number[];
  rareDf?: number;
  seedCount?: number;
  micro?: boolean;
  displaySeeds?: boolean;
}
// NFKC display text retains case. Map lowercase expansions back to display offsets.
export function tokenOffsets(original: string) {
  const text = original.normalize("NFKC"),
    lower = text.toLowerCase(),
    starts: number[] = [],
    ends: number[] = [];
  let source = 0;
  for (const c of text) {
    const end = source + c.length;
    for (let j = 0; j < c.toLowerCase().length; j++) {
      starts.push(source);
      ends.push(end);
    }
    source = end;
  }
  const terms: string[] = [],
    a: number[] = [],
    b: number[] = [];
  for (const m of lower.matchAll(/[\p{L}\p{N}]+/gu)) {
    terms.push(m[0]);
    a.push(starts[m.index!]);
    b.push(ends[m.index! + m[0].length - 1]);
  }
  return { text, terms, starts: a, ends: b };
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export async function buildGlobal(options: GlobalBuildOptions) {
  const started = performance.now(),
    out = options.out;
  await mkdir(out, { recursive: true });
  const source = options.source ?? out + "/source";
  if (!options.source)
    await buildSource({
      input: options.input,
      out: source,
      budget: 48 * 1048576,
      pagedStaging: true,
      chunkDocs: 100,
    });
  const sourceBytes = await readFile(source + "/bundle.bin"),
    manifest = JSON.parse(await readFile(source + "/manifest.json", "utf8"));
  if (
    createHash("sha256").update(sourceBytes).digest("hex") !==
    manifest.bundleSha256
  )
    throw Error("Global source bundle mismatch");
  const verifier = sourceVerifier(manifest);
  const index = new BinaryIndex(sourceBytes),
    pageBytes = options.pageBytes ?? 131072,
    packer = new PagePacker(out + "/packs", pageBytes);
  for await (const line of jsonLines(options.input))
    if (line.trim()) verifier.add(JSON.parse(line));
  verifier.verify(index.generation);
  try {
    await packer.start();
    const records = new Uint32Array(index.count * 5),
      firstChunks = new Uint32Array(index.count * 5),
      chunkStarts = new Uint32Array(index.count + 1),
      chunkFile = await open(out + "/chunks.tmp", "w");
    let doc = 0,
      chunks = 0;
    for await (const line of jsonLines(options.input)) {
      if (!line.trim()) continue;
      const d = JSON.parse(line);
      if (doc >= index.count || d.id !== index.document(doc).id)
        throw Error("Global corpus/source ID mismatch");
      const tokens = tokenOffsets(d.body),
        refs: Address[] = [];
      if (tokens.terms.length !== index.lengths(doc).body)
        throw Error("Global tokenization mismatch");
      for (
        let pos = 0;
        pos < Math.max(1, tokens.terms.length);
        pos += CHUNK_TOKENS
      ) {
        const first = Math.max(0, pos - 24),
          end = Math.min(tokens.terms.length, pos + CHUNK_TOKENS + 24),
          charStart = tokens.starts[first] ?? 0,
          charEnd = tokens.ends[end - 1] ?? tokens.text.length;
        const payload = {
          first,
          text: tokens.text.slice(charStart, charEnd),
          starts: tokens.starts.slice(first, end).map((n) => n - charStart),
          ends: tokens.ends.slice(first, end).map((n) => n - charStart),
        };
        refs.push(await packer.put(encoder.encode(JSON.stringify(payload))));
      }
      const record = await packer.put(
        encoder.encode(
          JSON.stringify({
            id: d.id,
            title: d.title,
            metadata: d.metadata,
            preview: tokens.text.slice(0, 400),
          }),
        ),
      );
      records.set(record, doc * 5);
      firstChunks.set(refs[0], doc * 5);
      chunkStarts[doc] = chunks;
      const addresses = Uint32Array.from(refs.flat());
      await chunkFile.writeFile(new Uint8Array(addresses.buffer));
      chunks += refs.length;
      doc++;
      if (doc % 10000 === 0) console.log("Global documents", doc);
    }
    await chunkFile.close();
    if (doc !== index.count) throw Error("Global input count mismatch");
    chunkStarts[doc] = chunks;
    const chunkBytes = await readFile(out + "/chunks.tmp"),
      chunkWords = new Uint32Array(
        chunkBytes.buffer,
        chunkBytes.byteOffset,
        chunkBytes.byteLength / 4,
      );
    const chunkAt = (doc: number, chunk: number) =>
      Array.from(
        chunkWords.subarray(
          (chunkStarts[doc] + chunk) * 5,
          (chunkStarts[doc] + chunk + 1) * 5,
        ),
      ) as Address;
    const disk = new FileStorage(source + "/objects"),
      sourceCache = new SearchRuntime(8 * 1048576);
    const read: Read = async (e, positions, offset, length) => {
      const object = positions ? e.positionObject : e.object,
        base = positions ? e.positionOffset : e.offset;
      if (object === LOCAL)
        return index.bytes.subarray(
          index.local + base + offset,
          index.local + base + offset + length,
        );
      const key = index.key(object, positions ? "positions" : "frequencies"),
        cacheKey = key + ":" + (base + offset) + ":" + length;
      let b = sourceCache.get<Uint8Array>(cacheKey);
      if (!b) {
        b = await disk.read(key, base + offset, length);
        sourceCache.set(cacheKey, b, b.length);
      }
      return b;
    };
    async function* sourceLists(e: Entry) {
      if (e.df <= BLOCK_SIZE || (e.format ?? 4) < 5) {
        yield await loadPosting(e, true, read);
        return;
      }
      const directory = await read(
          e,
          false,
          0,
          directoryLength(e.df, e.format),
        ),
        blocks = decodeDirectory(
          directory,
          e.df,
          e.length,
          e.positionLength,
          e.crc,
        );
      for (const b of blocks) {
        const [f, p] = await Promise.all([
          read(e, false, b.offset, b.length),
          read(e, true, b.positionOffset, b.positionLength),
        ]);
        const list: DecodedPostings = {
          docs: new Uint32Array(b.count),
          body: new Uint32Array(b.count),
          title: new Uint32Array(b.count),
          bytes: p,
          positionOffsets: new Uint32Array(b.count),
        };
        decodeBlockInto(f, 0, b, list, 0, p, 0);
        yield list;
      }
    }
    const db = new DatabaseSync(out + "/terms.sqlite");
    db.exec(
      "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-8192; DROP TABLE IF EXISTS terms; CREATE TABLE terms(term TEXT, sort BLOB PRIMARY KEY, df INTEGER, payload BLOB, cost INTEGER)",
    );
    const insert = db.prepare("INSERT INTO terms VALUES(?,?,?,?,?)");
    const sortKey = (term: string) => {
      const b = Buffer.alloc(term.length * 2);
      for (let i = 0; i < term.length; i++)
        b.writeUInt16BE(term.charCodeAt(i), i * 2);
      return b;
    };
    async function writeTerm(
      term: string,
      df: number,
      sourceRows: AsyncIterable<Row>,
    ) {
      const blocks: Block[] = [],
        rare: Row[] = [],
        seeds: Row[] = [];
      let pending: Row[] = [],
        tile = -1,
        omitted = 0,
        omittedDoc = 0xffffffff;
      const dropped = (r: Row) => {
        omitted = Math.max(omitted, r.b + 2 * r.t);
        omittedDoc = Math.min(omittedDoc, r.doc);
      };
      const emit = async (rows: Row[]): Promise<void> => {
        if (!rows.length) return;
        const f = encodeRows(rows),
          p = encodeRows(rows, true);
        if (f.length > MAX_RAW || p.length > MAX_RAW) {
          if (rows.length === 1)
            throw Error("One document exceeds global block budget");
          const middle = rows.length >>> 1;
          await emit(rows.slice(0, middle));
          await emit(rows.slice(middle));
          return;
        }
        let frequency: Address, positions: Address;
        try {
          frequency = await packer.put(f);
          positions = await packer.put(p);
        } catch (error) {
          if (rows.length === 1 || !String(error).includes("one page"))
            throw error;
          const middle = rows.length >>> 1;
          await emit(rows.slice(0, middle));
          await emit(rows.slice(middle));
          return;
        }
        blocks.push({
          tile: Math.floor(rows[0].doc / TILE_DOCS),
          first: rows[0].doc,
          last: rows.at(-1)!.doc,
          count: rows.length,
          b: Math.max(...rows.map((r) => r.b)),
          t: Math.max(...rows.map((r) => r.t)),
          frequency,
          positions,
        });
      };
      for await (const r of sourceRows) {
        const nextTile = Math.floor(r.doc / TILE_DOCS);
        if (nextTile !== tile || pending.length === 128) {
          await emit(pending);
          pending = [];
          tile = nextTile;
        }
        pending.push(r);
        if (df <= (options.rareDf ?? 8)) rare.push(r);
        if (term) {
          seeds.push(r);
          seeds.sort(
            (a, b) => b.b + 2 * b.t - (a.b + 2 * a.t) || a.doc - b.doc,
          );
          if (seeds.length > (options.seedCount ?? 32)) dropped(seeds.pop()!);
        }
      }
      await emit(pending);
      seeds.sort((a, b) => a.doc - b.doc);
      const seedBytes = encodeRows(seeds),
        inline = rare.length ? encodeRows(rare) : undefined;
      const t: Term = {
        df,
        blocks,
        inline,
        inlinePositions: rare.length ? encodeRows(rare, true) : undefined,
        seeds: seedBytes.length <= 32768 ? seedBytes : undefined,
        omitted,
        omittedDoc,
      };
      const payload = encodeTerm(t);
      insert.run(
        term,
        sortKey(term),
        df,
        payload,
        payload.length + term.length * 3 + 24,
      );
    }
    async function* universal() {
      for (let doc = 0; doc < index.count; doc++)
        yield {
          doc,
          id: index.document(doc).id,
          body: 0,
          title: 0,
          b: 0,
          t: 0,
          record: Array.from(records.subarray(doc * 5, doc * 5 + 5)) as Address,
          passage: Array.from(
            firstChunks.subarray(doc * 5, doc * 5 + 5),
          ) as Address,
          first: 0,
          bp: [],
          tp: [],
          chunks: [[0, chunkAt(doc, 0)]],
        } as Row;
    }
    await writeTerm("", index.count, universal());
    for (let i = 0; i < index.termCount; i++) {
      const e = index.entry(i);
      async function* rows() {
        for await (const list of sourceLists(e))
          for (let j = 0; j < list.docs.length; j++) {
            const doc = list.docs[j],
              positions = postingPositions(list, j),
              lengths = index.lengths(doc),
              bp = Array.from(positions.body),
              tp = Array.from(positions.title),
              chunkIds = [
                ...new Set(bp.map((p) => Math.floor(p / CHUNK_TOKENS))),
              ];
            yield {
              doc,
              id: index.document(doc).id,
              body: list.body[j],
              title: list.title[j],
              b: bm25(
                list.body[j],
                e.df,
                index.count,
                lengths.body,
                index.avgBody,
              ),
              t: bm25(
                list.title[j],
                e.df,
                index.count,
                lengths.title,
                index.avgTitle,
              ),
              record: Array.from(
                records.subarray(doc * 5, doc * 5 + 5),
              ) as Address,
              passage: chunkAt(doc, chunkIds[0] ?? 0),
              first: bp[0] ?? 0xffffffff,
              bp,
              tp,
              chunks: chunkIds.map(
                (chunk) => [chunk, chunkAt(doc, chunk)] as [number, Address],
              ),
            };
          }
      }
      await writeTerm(e.term, e.df, rows());
      if (i % 10000 === 0) console.log("Global terms", i, index.termCount);
    }
    db.exec(
      "CREATE INDEX by_df ON terms(df DESC,sort); CREATE INDEX by_cost ON terms(cost,sort)",
    );
    const dictionary: Root["dictionary"] = [];
    let pending: [string, Uint8Array][] = [],
      bytes = 0;
    const flush = async () => {
      if (!pending.length) return;
      const address = await packer.put(encodeDictionary(pending), true);
      dictionary.push({
        first: pending[0][0],
        last: pending.at(-1)![0],
        address,
      });
      pending = [];
      bytes = 0;
    };
    for (const e of db
      .prepare("SELECT term,payload,df FROM terms ORDER BY sort")
      .iterate() as Iterable<{
      term: string;
      payload: Uint8Array;
      df: number;
    }>) {
      if (bytes + e.payload.length + e.term.length * 3 + 20 > pageBytes * 0.7)
        await flush();
      pending.push([e.term, e.payload]);
      bytes += e.payload.length + e.term.length * 3 + 20;
    }
    await flush();
    const objects = await packer.finish(),
      generation = createHash("sha256")
        .update(
          JSON.stringify({
            version: 1,
            source: manifest.bundleSha256,
            objects,
            pageBytes,
            chunkTokens: CHUNK_TOKENS,
          }),
        )
        .digest("hex");
    const root: Root = {
      version: 1,
      generation,
      count: index.count,
      avgBody: index.avgBody,
      avgTitle: index.avgTitle,
      pageBytes,
      objectPages: packer.objectBytes / pageBytes,
      dictionary,
      objects,
      hotBytes: 0,
    };
    const roots: any[] = [];
    for (const budget of options.budgets ?? [8 * 1048576]) {
      const reserve = JSON.stringify(root).length + 4096,
        selected = new Map<string, Uint8Array>();
      let charge = 8;
      const take = (e: { term: string; payload: Uint8Array; df: number }) => {
        const cost = e.payload.length + e.term.length * 3 + 24;
        if (charge + cost + reserve <= budget) {
          selected.set(e.term, e.payload);
          charge += cost;
        }
      };
      // Spend half on frequent-term plans/seeds, then whole rare postings, then more plans.
      for (const e of db
        .prepare("SELECT term,payload,df FROM terms ORDER BY df DESC,sort")
        .iterate() as Iterable<{
        term: string;
        payload: Uint8Array;
        df: number;
      }>) {
        if (charge > budget * 0.45) break;
        take(e);
      }
      for (const e of db
        .prepare("SELECT term,payload,df FROM terms ORDER BY cost,sort")
        .iterate() as Iterable<{
        term: string;
        payload: Uint8Array;
        df: number;
      }>) {
        if (selected.has(e.term)) continue;
        if (
          charge + e.payload.length + e.term.length * 3 + 24 + reserve >
          budget
        )
          break;
        take(e);
      }
      const hot = encodeDictionary(
          [...selected].sort(([a], [b]) => compare(a, b)),
        ),
        bundle = encodeRoot({ ...root, hotBytes: hot.length }, hot);
      if (bundle.length > budget) throw Error("Global bundle budget exceeded");
      const name = `bundle-${budget / 1048576}.bin`;
      await writeFile(out + "/" + name, bundle);
      roots.push({
        budget,
        bundleBytes: bundle.length,
        name,
        hotTerms: selected.size,
        sha256: createHash("sha256").update(bundle).digest("hex"),
      });
    }
    await writeFile(out + "/root.json", JSON.stringify(root));
    const result = {
      version: 1,
      generation,
      documents: index.count,
      terms: index.termCount,
      ms: performance.now() - started,
      pageBytes,
      objects,
      roots,
    };
    await writeFile(out + "/manifest.json", JSON.stringify(result, null, 2));
    db.close();
    await rm(out + "/chunks.tmp");
    if (options.micro === false) return result;
    const micro = await addMicroPlans(out);
    return options.displaySeeds === false ? micro : await addDisplaySeeds(out);
  } finally {
    await packer.abort();
  }
}
