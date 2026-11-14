import type { Source } from "./storage.js";
/** Generation and range identity come with the same R2 response. */
export class ColumnarR2 implements Source {
  constructor(readonly bucket: R2Bucket) {}
  async readNamed(key: string, bytes: number) {
    if (
      !/^[a-f0-9]{64}\/(?:pairs-\d+-\d+-[a-f0-9]+-[a-f0-9]+|presence-\d+|metadata)\.bin$/.test(
        key,
      ) ||
      bytes > 32 * 1048576
    )
      throw Error("Invalid pair object");
    const object = await this.bucket.get(key);
    if (
      !object ||
      object.size !== bytes ||
      object.customMetadata?.generation !== key.split("/")[0] ||
      (key.endsWith("/metadata.bin") &&
        object.customMetadata.sha256 !== key.split("/")[0])
    )
      throw Error("Pair object generation mismatch");
    return new Uint8Array(await object.arrayBuffer());
  }
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
        end = Number(object.customMetadata.packageEnd);
      if (
        first !== range.first ||
        !Number.isSafeInteger(end) ||
        end <= first ||
        range.doc < first ||
        range.doc >= end ||
        data.length !== range.length
      )
        throw Error("Invalid grouped document identity");
      return { data };
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
    const data = new Uint8Array(await object.arrayBuffer());
    if (data.length !== length) throw Error("Truncated R2 object");
    return { data };
  }
  async read(key: string, offset: number, length: number) {
    return (await this.readPage(key, offset, length)).data;
  }
}
