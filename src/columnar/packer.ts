import { openSync, writeSync, closeSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { crc32 } from "../format/codec.js";
import { PAGE, OBJECT, type Root, type Ref } from "./format.js";
export class Packer {
  object = -1;
  at = 0;
  buffer = Buffer.alloc(OBJECT);
  constructor(
    readonly dir: string,
    readonly store = { next: 0, objects: [] as Root["objects"] },
  ) {}
  get objects() {
    return this.store.objects;
  }
  flush() {
    if (!this.at) return;
    const b = this.buffer.subarray(0, this.at),
      name = `plan-${this.object}.bin`,
      fd = openSync(`${this.dir}/${name}.writing`, "w");
    writeSync(fd, b);
    closeSync(fd);
    renameSync(`${this.dir}/${name}.writing`, `${this.dir}/${name}`);
    const checksums = [];
    for (let p = 0; p < b.length; p += PAGE)
      checksums.push(crc32(b.subarray(p, p + PAGE)));
    this.objects[this.object] = {
      name,
      size: b.length,
      sha256: createHash("sha256").update(b).digest("hex"),
      checksums,
    };
    this.object = -1;
    this.at = 0;
    this.buffer.fill(0);
  }
  put(b: Uint8Array): Ref {
    if (!b.length || b.length > OBJECT)
      throw Error("Invalid immutable blob size");
    let at = Math.ceil(this.at / 8) * 8;
    if (b.length <= PAGE && (at % PAGE) + b.length > PAGE)
      at = Math.ceil(at / PAGE) * PAGE;
    if (at + b.length > OBJECT) {
      this.flush();
      at = 0;
    }
    if (this.object < 0) this.object = this.store.next++;
    this.buffer.set(b, at);
    this.at = at + b.length;
    return [this.object, at, b.length];
  }
}
