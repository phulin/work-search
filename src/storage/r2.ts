import type { Storage } from "./types.js";
export class R2Storage implements Storage {
  constructor(
    readonly bucket: R2Bucket,
    readonly generation: string,
  ) {}
  async open(key: string, offset: number, length: number) {
    if (!key.startsWith(this.generation + "/"))
      throw Error("Generation mismatch");
    const o = await this.bucket.get(key, { range: { offset, length } });
    if (!o) throw Error("Missing index object");
    if (o.customMetadata?.generation !== this.generation)
      throw Error("Object generation mismatch");
    return {
      bytes: o.arrayBuffer().then((buffer) => {
        const b = new Uint8Array(buffer);
        if (b.length !== length) throw Error("Truncated R2 object");
        return b;
      }),
    };
  }
  async read(key: string, offset: number, length: number) {
    return (await this.open(key, offset, length)).bytes;
  }
}
