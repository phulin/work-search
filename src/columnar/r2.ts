import type { Source } from "./storage.js";
import { PAGE } from "./format.js";
/** Integrity metadata comes with the same R2 range response. Large generations
 * need not bundle every page checksum or add a remote discovery request. */
export class ColumnarR2 implements Source {
  constructor(readonly bucket: R2Bucket) {}
  async readWhole(
    key: string,
    range?: { offset: number; length: number; doc: number; first: number },
  ) {
    if (!/^[a-f0-9]{64}\/plan-\d+\.bin$/.test(key))
      throw Error("Invalid package key");
    if (
      range &&
      (!Number.isInteger(range.offset) ||
        range.offset < 0 ||
        !Number.isInteger(range.length) ||
        range.length < 64 ||
        range.length > 32 * 1048576)
    )
      throw Error("Invalid package range");
    const object = await this.bucket.get(
      key,
      range
        ? { range: { offset: range.offset, length: range.length } }
        : undefined,
    );
    if (!object || object.customMetadata?.generation !== key.split("/")[0])
      throw Error("Document package generation mismatch");
    if (!range && object.size > 32 * 1048576)
      throw Error("Oversized document package");
    const sha256 = object.customMetadata.sha256;
    if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256))
      throw Error("Missing document package digest");
    const data = new Uint8Array(await object.arrayBuffer());
    if (range) {
      if (sha256 !== key.split("/")[0])
        throw Error("Document group digest mismatch");
      const first = Number(object.customMetadata.packageFirst),
        end = Number(object.customMetadata.packageEnd),
        raw = atob(object.customMetadata.packageCrc32 ?? ""),
        at = (range.doc - first) * 4;
      if (
        first !== range.first ||
        range.doc < first ||
        range.doc >= end ||
        raw.length !== (end - first) * 4 ||
        data.length !== range.length
      )
        throw Error("Invalid grouped document identity");
      const checksum =
        (raw.charCodeAt(at) |
          (raw.charCodeAt(at + 1) << 8) |
          (raw.charCodeAt(at + 2) << 16) |
          (raw.charCodeAt(at + 3) << 24)) >>>
        0;
      return { data, checksum };
    }
    if (data.length !== object.size) throw Error("Truncated document package");
    return { data, sha256 };
  }
  async readPage(
    key: string,
    offset: number,
    length: number,
    expectedSha256?: string,
  ) {
    if (!/^[a-f0-9]{64}\/plan-\d+\.bin$/.test(key))
      throw Error("Invalid immutable key");
    const object = await this.bucket.get(key, { range: { offset, length } });
    if (!object) throw Error("Missing index object");
    if (object.customMetadata?.generation !== key.split("/")[0])
      throw Error("Object generation mismatch");
    if (expectedSha256 && object.customMetadata?.sha256 !== expectedSha256)
      throw Error("Object digest mismatch");
    let checksum: number | undefined;
    const encoded = object.customMetadata?.crc32;
    if (encoded) {
      const raw = atob(encoded),
        at = (offset / PAGE) * 4;
      if (!Number.isInteger(at) || at + 4 > raw.length)
        throw Error("Invalid page checksum metadata");
      checksum =
        (raw.charCodeAt(at) |
          (raw.charCodeAt(at + 1) << 8) |
          (raw.charCodeAt(at + 2) << 16) |
          (raw.charCodeAt(at + 3) << 24)) >>>
        0;
    }
    const data = new Uint8Array(await object.arrayBuffer());
    if (data.length !== length) throw Error("Truncated R2 object");
    return { data, checksum };
  }
  async read(key: string, offset: number, length: number) {
    return (await this.readPage(key, offset, length)).data;
  }
}
