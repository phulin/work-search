import { open } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Storage } from "./types.js";
export class FileStorage implements Storage {
  constructor(readonly root: string) {}
  async read(key: string, offset: number, length: number) {
    const path = resolve(this.root, key);
    if (!path.startsWith(resolve(this.root) + sep))
      throw new Error("Invalid key");
    const f = await open(path, "r");
    try {
      const b = new Uint8Array(length);
      const { bytesRead } = await f.read(b, 0, length, offset);
      if (bytesRead !== length) throw new Error("Truncated object");
      return b;
    } finally {
      await f.close();
    }
  }
}
