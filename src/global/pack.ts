import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { crc32 } from "../format/codec.js";
import { MAX_RAW, type Address } from "./format.js";
export class PagePacker {
  private object = 0;
  private offset = 0;
  private file: Awaited<ReturnType<typeof open>> | undefined;
  readonly objects: { name: string; size: number; sha256: string }[] = [];
  readonly objectBytes = 64 * 1048576;
  constructor(
    readonly out: string,
    readonly pageBytes = 131072,
    readonly initialObject = 0,
  ) {}
  async start() {
    this.object = this.initialObject;
    if (![65536, 131072, 262144].includes(this.pageBytes))
      throw Error("Unsupported page size");
    await mkdir(this.out, { recursive: true });
    this.file = await open(this.out + `/plan-${this.object}.bin`, "w");
  }
  private async zeros(n: number) {
    if (n) {
      await this.file!.writeFile(new Uint8Array(n));
      this.offset += n;
    }
  }
  private async closeObject() {
    await this.zeros(
      (this.pageBytes - (this.offset % this.pageBytes)) % this.pageBytes,
    );
    await this.file!.close();
    this.file = undefined;
    const b = await readFile(this.out + `/plan-${this.object}.bin`);
    this.objects.push({
      name: `plan-${this.object}.bin`,
      size: b.length,
      sha256: createHash("sha256").update(b).digest("hex"),
    });
  }
  async put(raw: Uint8Array, spanning = false): Promise<Address> {
    if (raw.length > MAX_RAW)
      throw Error("Global payload expansion exceeds block limit");
    const b = gzipSync(raw, { level: 1 });
    if (!spanning && b.length > this.pageBytes)
      throw Error("Global payload exceeds one page");
    if ((this.offset % this.pageBytes) + b.length > this.pageBytes)
      await this.zeros(this.pageBytes - (this.offset % this.pageBytes));
    if (this.offset + b.length > this.objectBytes) {
      await this.closeObject();
      this.object++;
      this.offset = 0;
      this.file = await open(this.out + `/plan-${this.object}.bin`, "w");
    }
    const ref: Address = [
      this.object,
      this.offset,
      b.length,
      crc32(b),
      raw.length,
    ];
    await this.file!.writeFile(b);
    this.offset += b.length;
    return ref;
  }
  async abort() {
    if (this.file) {
      await this.file.close();
      this.file = undefined;
    }
  }
  async finish() {
    await this.closeObject();
    await writeFile(this.out + "/objects.json", JSON.stringify(this.objects));
    return this.objects;
  }
}
