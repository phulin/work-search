import type { Storage } from "./types.js";
export class R2Storage implements Storage {
  constructor(
    readonly bucket: R2Bucket,
    readonly generation: string,
  ) {}
  async read(key: string, offset: number, length: number) {
    if (!key.startsWith(this.generation + "/"))
      throw new Error("Generation mismatch");
    const o = await this.bucket.get(key, { range: { offset, length } });
    if (!o) throw new Error("Missing index object");
    if (o.customMetadata?.generation !== this.generation)
      throw new Error("Object generation mismatch");
    const b = new Uint8Array(await o.arrayBuffer());
    if (b.length !== length) throw new Error("Truncated R2 object");
    return b;
  }
}
