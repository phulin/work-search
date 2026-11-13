// Offline builders may consume already-published immutable objects without
// retaining a second full local copy. This is not a serving dependency.
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Root, Ref } from "./format.js";
import { PAGE, concat, objectAt } from "./format.js";
import { Lru, Semaphore } from "./storage.js";
import { crc32 } from "../format/codec.js";
export class OfflineObjects {
  files = new Map<
    number,
    Promise<Awaited<ReturnType<typeof open>> | undefined>
  >();
  objects = new Map<number, Uint8Array>();
  pages = new Lru<Uint8Array>(32 * 1048576);
  pageReads = new Map<string, Promise<Uint8Array>>();
  users = new Map<number, number>();
  downloads = new Map<number, Promise<Uint8Array>>();
  downloadSlots = new Semaphore(2);
  pageSlots = new Semaphore(6);
  validated = new Map<number, Promise<void>>();
  keys?: Map<string, number>;
  source = {
    read: (key: string, offset: number, length: number) =>
      this.readKey(key, offset, length),
    readPage: async (key: string, offset: number, length: number) => {
      const data = await this.readKey(key, offset, length);
      return { data, checksum: crc32(data) };
    },
  };
  constructor(
    readonly dir: string,
    readonly root: Pick<Root, "generation" | "objects" | "objectIds">,
    readonly remote?: { url: string; token: string },
  ) {}
  async readKey(key: string, offset: number, length: number) {
    this.keys ??= new Map(
      this.root.objects.map((o, i) => [
        o.key ?? `${this.root.generation}/${o.name}`,
        this.root.objectIds?.[i] ?? i,
      ]),
    );
    const id = this.keys.get(key);
    if (id === undefined) throw Error("Unknown offline object key");
    return this.read([id, offset, length]);
  }
  async read(ref: Ref) {
    const [id, offset, length] = ref;
    const object = objectAt(this.root, id);
    if (!object || offset < 0 || length < 1 || offset + length > object.size)
      throw Error("Invalid offline reference");
    let task = this.files.get(id),
      cached = this.objects.get(id);
    if (cached) {
      this.objects.delete(id);
      this.objects.set(id, cached);
      return cached.subarray(offset, offset + length);
    }
    if (!task) {
      task = open(this.dir + "/packs/" + object.name, "r").catch((e) => {
        if (e.code !== "ENOENT" || !this.remote) throw e;
        return undefined;
      });
      this.files.set(id, task);
    }
    this.users.set(id, (this.users.get(id) ?? 0) + 1);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await task;
      if (file) {
        if (!object.checksums) {
          let validation = this.validated.get(id);
          if (!validation) {
            const handle = file;
            validation = (async () => {
              const hash = createHash("sha256");
              for await (const chunk of handle.createReadStream({
                start: 0,
                autoClose: false,
              }))
                hash.update(chunk);
              if (hash.digest("hex") !== object.sha256)
                throw Error("Offline immutable checksum mismatch");
            })();
            this.validated.set(id, validation);
          }
          await validation;
        }
        const first = Math.floor(offset / PAGE),
          last = Math.floor((offset + length - 1) / PAGE),
          parts: Uint8Array[] = [];
        for (let page = first; page <= last; page++) {
          const key = `${id}:${page}`;
          let data = this.pages.get(key);
          if (!data) {
            let pending = this.pageReads.get(key);
            if (!pending) {
              const position = page * PAGE,
                size = Math.min(PAGE, object.size - position),
                handle = file;
              pending = (async () => {
                const b = Buffer.alloc(size);
                if (
                  (await handle.read(b, 0, size, position)).bytesRead !== size
                )
                  throw Error("Truncated offline object");
                this.pages.set(key, b, b.length);
                return b;
              })();
              this.pageReads.set(key, pending);
            }
            try {
              data = await pending;
            } finally {
              this.pageReads.delete(key);
            }
          }
          parts.push(data);
        }
        const bytes = parts.length === 1 ? parts[0] : concat(parts);
        return bytes.subarray(offset % PAGE, (offset % PAGE) + length);
      }
    } finally {
      this.users.set(id, this.users.get(id)! - 1);
      // Lease open handles through each read so concurrent callers cannot close
      // a descriptor another call is still using.
      for (const [old, handle] of this.files) {
        if (this.files.size <= 64) break;
        if (this.users.get(old)) continue;
        this.files.delete(old);
        this.users.delete(old);
        await (await handle)?.close();
      }
    }
    if (offset !== 0 || length !== object.size || object.size <= PAGE * 8) {
      const parts: Uint8Array[] = [];
      for (
        let page = Math.floor(offset / PAGE);
        page <= Math.floor((offset + length - 1) / PAGE);
        page++
      ) {
        const key = `${id}:${page}`;
        let data = this.pages.get(key);
        if (!data) {
          let task = this.pageReads.get(key);
          if (!task) {
            task = this.pageSlots.run(() => this.remotePage(id, page));
            this.pageReads.set(key, task);
          }
          try {
            data = await task;
          } finally {
            this.pageReads.delete(key);
          }
        }
        parts.push(data);
      }
      const data = parts.length === 1 ? parts[0] : concat(parts);
      return data.subarray(offset % PAGE, (offset % PAGE) + length);
    }
    let download = this.downloads.get(id);
    if (!download) {
      download = this.downloadSlots.run(() => this.download(id));
      this.downloads.set(id, download);
    }
    try {
      return (await download).subarray(offset, offset + length);
    } finally {
      this.downloads.delete(id);
    }
  }
  async remotePage(id: number, page: number) {
    const object = objectAt(this.root, id),
      offset = page * PAGE,
      length = Math.min(PAGE, object.size - offset),
      key = object.key ?? `${this.root.generation}/${object.name}`;
    for (let attempt = 0; ; attempt++)
      try {
        const r = await fetch(`${this.remote!.url}/${key}`, {
          headers: {
            authorization: `Bearer ${this.remote!.token}`,
            "x-offset": String(offset),
            "x-length": String(length),
          },
          signal: AbortSignal.timeout(120000),
        });
        if (
          !r.ok ||
          r.headers.get("x-sha256") !== object.sha256 ||
          r.headers.get("x-generation") !== key.split("/")[0]
        )
          throw Error("Offline page identity mismatch " + r.status);
        const data = new Uint8Array(await r.arrayBuffer()),
          directory = r.headers.get("x-page-crc32");
        let checksum = object.checksums?.[page];
        if (checksum === undefined && directory) {
          const bytes = Buffer.from(directory, "base64");
          if (page * 4 + 4 > bytes.length)
            throw Error("Truncated offline page checksums");
          checksum = bytes.readUInt32LE(page * 4);
        }
        if (
          data.length !== length ||
          checksum === undefined ||
          crc32(data) !== checksum
        )
          throw Error("Offline page checksum mismatch");
        this.pages.set(`${id}:${page}`, data, data.length);
        return data;
      } catch (e) {
        if (attempt === 4) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
  }
  async download(id: number) {
    const object = objectAt(this.root, id);
    let cached: Uint8Array | undefined;
    for (let attempt = 0; ; attempt++)
      try {
        const r = await fetch(
          `${this.remote!.url}/${object.key ?? `${this.root.generation}/${object.name}`}`,
          {
            headers: { authorization: `Bearer ${this.remote!.token}` },
            signal: AbortSignal.timeout(180000),
          },
        );
        if (!r.ok) throw Error("Offline immutable GET " + r.status);
        cached = new Uint8Array(await r.arrayBuffer());
        if (
          cached.length !== object.size ||
          createHash("sha256").update(cached).digest("hex") !== object.sha256
        )
          throw Error("Offline immutable checksum mismatch");
        break;
      } catch (e) {
        if (attempt === 4) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    // At most two physical objects, independently of corpus size.
    if (this.objects.size === 2)
      this.objects.delete(this.objects.keys().next().value!);
    this.objects.set(id, cached!);
    return cached!;
  }
  async close() {
    for (const file of this.files.values()) await (await file)?.close();
    this.files.clear();
    this.objects.clear();
    this.pages.clear();
    this.validated.clear();
  }
}
