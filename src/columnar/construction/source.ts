import { crc32 } from "../../format/codec.js";
export interface SourcePart {
  part: number;
  generation: string;
  first: number;
  count: number;
  inputSha256: string;
}
export interface SourceRoot {
  format: "R2-source-v1";
  documents: number;
  parts: SourcePart[];
}
export class CorpusSource {
  requests = 0;
  bytes = 0;
  buffered: {
    generation: string;
    name: string;
    offset: number;
    bytes: Uint8Array;
  }[] = [];
  constructor(
    readonly bucket: R2Bucket,
    readonly root: SourceRoot,
  ) {}
  part(doc: number) {
    if (!Number.isInteger(doc) || doc < 0 || doc >= this.root.documents)
      throw Error("Invalid source document");
    let lo = 0,
      hi = this.root.parts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.root.parts[mid].first <= doc) lo = mid + 1;
      else hi = mid;
    }
    const p = this.root.parts[lo - 1];
    if (!p || doc >= p.first + p.count) throw Error("Source partition gap");
    return p;
  }
  async get(
    generation: string,
    name: string,
    offset?: number,
    length?: number,
  ) {
    if (offset !== undefined && length !== undefined) {
      const hit = this.buffered.find(
        (b) =>
          b.generation === generation &&
          b.name === name &&
          b.offset <= offset &&
          b.offset + b.bytes.length >= offset + length,
      );
      if (hit)
        return {
          bytes: hit.bytes.subarray(
            offset - hit.offset,
            offset - hit.offset + length,
          ),
          sha256: undefined,
          size: hit.bytes.length,
        };
    }
    this.requests++;
    const object = await this.bucket.get(
      `${generation}/${name}`,
      offset === undefined ? undefined : { range: { offset, length } },
    );
    if (!object || object.customMetadata?.generation !== generation)
      throw Error("Source object identity mismatch " + generation + "/" + name);
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (length !== undefined && bytes.length !== length)
      throw Error("Truncated source range");
    this.bytes += bytes.length;
    return { bytes, sha256: object.customMetadata?.sha256, size: object.size };
  }
  /** Archive records are already contiguous. Coalesce their physical ranges,
   * retaining compressed bytes only, rather than making two R2 calls per doc. */
  async prefetch(
    pointers: Awaited<ReturnType<CorpusSource["pointers"]>>,
    maxBytes = 2 * 1048576,
  ) {
    this.buffered = [];
    const ranges = new Map<string, { offset: number; end: number }>(),
      v = pointers.view;
    let bytes = 0;
    for (let row = 0; row < v.byteLength / 32; row++) {
      const additions: [string, number, number][] = [];
      let extra = 0;
      for (const [field, prefix] of [
        [0, "content"],
        [16, "info"],
      ] as const) {
        const at = row * 32 + field,
          name = `${prefix}-${v.getUint32(at, true)}.bin`,
          offset = v.getUint32(at + 4, true),
          end = offset + v.getUint32(at + 8, true),
          old = ranges.get(name);
        extra += old
          ? Math.max(old.end, end) -
            Math.min(old.offset, offset) -
            (old.end - old.offset)
          : end - offset;
        additions.push([name, offset, end]);
      }
      if (bytes + extra > maxBytes) break;
      bytes += extra;
      for (const [name, offset, end] of additions) {
        const old = ranges.get(name);
        ranges.set(name, {
          offset: Math.min(old?.offset ?? offset, offset),
          end: Math.max(old?.end ?? end, end),
        });
      }
    }
    for (const [name, { offset, end }] of ranges) {
      const { bytes } = await this.get(
        pointers.part.generation,
        name,
        offset,
        end - offset,
      );
      this.buffered.push({
        generation: pointers.part.generation,
        name,
        offset,
        bytes,
      });
    }
    return bytes;
  }
  async pointers(first: number, count: number) {
    const part = this.part(first);
    if (count < 1 || first + count > part.first + part.count)
      throw Error("Cross-partition source range");
    const { bytes } = await this.get(
      part.generation,
      "contentmap-0.bin",
      (first - part.first) * 32,
      count * 32,
    );
    return {
      part,
      first,
      view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    };
  }
  async document(
    doc: number,
    pointers?: Awaited<ReturnType<CorpusSource["pointers"]>>,
    row = 0,
  ) {
    pointers ??= await this.pointers(doc, 1);
    if (pointers.first + row !== doc)
      throw Error("Source pointer identity mismatch");
    const { part, view } = pointers,
      p = Array.from({ length: 8 }, (_, i) =>
        view.getUint32(row * 32 + i * 4, true),
      ),
      [content, info] = await Promise.all([
        this.get(part.generation, `content-${p[0]}.bin`, p[1], p[2]),
        this.get(part.generation, `info-${p[4]}.bin`, p[5], p[6]),
      ]);
    if (crc32(content.bytes) !== p[3] || crc32(info.bytes) !== p[7])
      throw Error("Source document checksum mismatch");
    const record = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(info.bytes),
      ),
      body = await new Response(
        new Response(content.bytes as BodyInit).body!.pipeThrough(
          new DecompressionStream("gzip"),
        ),
      ).text();
    if (
      typeof record.id !== "string" ||
      !record.id ||
      (record.title !== undefined && typeof record.title !== "string")
    )
      throw Error("Invalid source record");
    return { ...record, body, doc };
  }
}
