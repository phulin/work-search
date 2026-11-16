import type { Source } from "./storage.js";
/** Generation and range identity come with the same R2 response. */
export class ColumnarR2 implements Source {
  timings?: {
    r2Reads: number;
    r2HeaderMs: number;
    r2BodyMs: number;
    r2MaxHeaderMs: number;
  };
  constructor(readonly bucket: R2Bucket) {}
  private async get(key: string, range?: { offset: number; length: number }) {
    const start = performance.now();
    try {
      return await this.bucket.get(key, range ? { range } : undefined);
    } finally {
      if (this.timings) {
        const ms = performance.now() - start;
        this.timings.r2Reads++;
        this.timings.r2HeaderMs += ms;
        this.timings.r2MaxHeaderMs = Math.max(this.timings.r2MaxHeaderMs, ms);
      }
    }
  }
  private async body(object: R2ObjectBody) {
    const start = performance.now();
    try {
      return new Uint8Array(await object.arrayBuffer());
    } finally {
      if (this.timings) this.timings.r2BodyMs += performance.now() - start;
    }
  }
  async readNamed(address: string, bytes: number) {
    const match =
        /^([a-f0-9]{64}\/(?:pairs|plan|positions)-\d+\.bin)@(\d+)$/.exec(
          address,
        ),
      key = match ? match[1] : address,
      offset = match ? Number(match[2]) : 0;
    if (
      (!match && !/^[a-f0-9]{64}\/(?:presence-\d+|metadata)\.bin$/.test(key)) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 0xffffffff ||
      bytes > 32 * 1048576
    )
      throw Error("Invalid named packet address");
    const object = await this.get(
      key,
      match ? { offset, length: bytes } : undefined,
    );
    if (
      !object ||
      object.size < offset + bytes ||
      (!match && object.size !== bytes) ||
      object.customMetadata?.generation !== key.split("/")[0] ||
      ((key.endsWith("/metadata.bin") || /\/plan-\d+\.bin$/.test(key)) &&
        object.customMetadata.sha256 !== key.split("/")[0])
    )
      throw Error("Pair object generation mismatch");
    const data = await this.body(object);
    if (data.length !== bytes) throw Error("Truncated named packet");
    return data;
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
    const object = await this.get(
      key,
      range ? { offset: range.offset, length: range.length } : undefined,
    );
    if (!object || object.customMetadata?.generation !== key.split("/")[0])
      throw Error("Document package generation mismatch");
    if (!range && object.size > 32 * 1048576)
      throw Error("Oversized document package");
    const sha256 = object.customMetadata.sha256;
    if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256))
      throw Error("Missing document package digest");
    const data = await this.body(object);
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
    const object = await this.get(key, { offset, length });
    if (!object) throw Error("Missing index object");
    if (object.customMetadata?.generation !== key.split("/")[0])
      throw Error("Object generation mismatch");
    if (expectedSha256 && object.customMetadata?.sha256 !== expectedSha256)
      throw Error("Object digest mismatch");
    const data = await this.body(object);
    if (data.length !== length) throw Error("Truncated R2 object");
    return { data };
  }
  async read(key: string, offset: number, length: number) {
    return (await this.readPage(key, offset, length)).data;
  }
}
