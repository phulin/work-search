import { open, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Root } from "../../src/columnar/format.js";
import { PAGE, view } from "../../src/columnar/format.js";
import type { Source } from "../../src/columnar/storage.js";
import { crc32 } from "../../src/format/codec.js";

type PackageMetadata = { first: number; checksums: number[] };
/** Persistent immutable data, independent of the simulated application caches.
 * Network is permitted only during preparation. Timed replay fails on a miss. */
export class LocalObjects implements Source {
  namedDirectory?: string;
  async readNamed(address: string, bytes: number) {
    const match =
        /^([a-f0-9]{64}\/(?:pairs|plan|positions)-\d+\.bin)@(\d+)$/.exec(
          address,
        ),
      key = match ? match[1] : address;
    if (match && key.includes("/plan-"))
      return this.range(this.path(key), Number(match[2]), bytes);
    if (
      !this.namedDirectory ||
      (!match && !/^[a-f0-9]{64}\/presence-\d+\.bin$/.test(key))
    )
      throw Error("Missing local named packet store");
    const name = key.split("/")[1],
      path =
        this.namedDirectory +
        (name.startsWith("presence-")
          ? "/presence/" + name.slice(9)
          : "/objects/" + name);
    return match ? this.range(path, Number(match[2]), bytes) : readFile(path);
  }
  remoteEnabled = false;
  downloads = 0;
  downloadedBytes = 0;
  private pending = new Map<string, Promise<Uint8Array>>();
  private mirrors = new Map<string, Promise<Uint8Array>>();
  private packageReads = new Map<string, Promise<PackageMetadata>>();
  private metadata = new Map<string, PackageMetadata>();
  private objects;
  constructor(
    readonly root: Root,
    readonly dir: string,
    readonly remote?: { url: string; token: string },
  ) {
    this.objects = new Map(
      root.objects.map((o) => [o.key ?? `${root.generation}/${o.name}`, o]),
    );
  }
  private path(key: string) {
    if (!/^[a-f0-9]{64}\/plan-\d+\.bin$/.test(key))
      throw Error("Invalid local immutable key");
    return this.dir + "/objects/" + key;
  }
  private async save(path: string, data: Uint8Array | string) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = path + "." + randomUUID() + ".writing";
    await writeFile(temporary, data);
    await rename(temporary, path);
  }
  private async download(key: string, offset?: number, length?: number) {
    if (!this.remoteEnabled || !this.remote)
      throw Error(
        `Missing local bytes: ${key}:${offset ?? "whole"}:${length ?? ""}; run preparation first`,
      );
    const id = `${key}:${offset}:${length}`;
    let task = this.pending.get(id);
    if (!task) {
      task = (async () => {
        for (let retry = 0; ; retry++) {
          try {
            const response = await fetch(`${this.remote!.url}/${key}`, {
              headers: {
                authorization: `Bearer ${this.remote!.token}`,
                ...(offset === undefined
                  ? {}
                  : { "x-offset": String(offset), "x-length": String(length) }),
              },
              signal: AbortSignal.timeout(180000),
            });
            const expected = this.objects.get(key)?.sha256 ?? key.split("/")[0];
            if (
              !response.ok ||
              response.headers.get("x-generation") !== key.split("/")[0] ||
              response.headers.get("x-sha256") !== expected
            )
              throw Error(
                "Local preparation identity mismatch: " + response.status,
              );
            const data = new Uint8Array(await response.arrayBuffer());
            if (length !== undefined && data.length !== length)
              throw Error("Truncated local preparation range");
            if (
              offset === undefined &&
              createHash("sha256").update(data).digest("hex") !== expected
            )
              throw Error("Local immutable digest mismatch");
            const encoded = response.headers.get("x-package-crc32");
            if (encoded) {
              const first = Number(response.headers.get("x-package-first")),
                end = Number(response.headers.get("x-package-end")),
                checksums = Buffer.from(encoded, "base64");
              if (
                !Number.isInteger(first) ||
                !Number.isInteger(end) ||
                first < 0 ||
                end <= first ||
                end > this.root.count ||
                checksums.length !== (end - first) * 4
              )
                throw Error("Invalid prepared package checksum table");
              const metadata = {
                first,
                checksums: Array.from({ length: end - first }, (_, i) =>
                  checksums.readUInt32LE(i * 4),
                ),
              };
              this.metadata.set(key, metadata);
              await this.save(
                this.path(key) + ".json",
                JSON.stringify(metadata),
              );
            }
            this.downloads++;
            this.downloadedBytes += data.length;
            return data;
          } catch (e) {
            if (retry === 4) throw e;
            await new Promise((r) => setTimeout(r, 500 * 2 ** retry));
          }
        }
      })();
      this.pending.set(id, task);
    }
    try {
      return await task;
    } finally {
      this.pending.delete(id);
    }
  }
  async mirror(key: string) {
    let task = this.mirrors.get(key);
    if (!task) {
      task = this.mirrorOnce(key);
      this.mirrors.set(key, task);
    }
    try {
      return await task;
    } finally {
      this.mirrors.delete(key);
    }
  }
  private async mirrorOnce(key: string) {
    const path = this.path(key),
      expected = this.objects.get(key)?.sha256 ?? key.split("/")[0];
    const old = await readFile(path).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    if (old) {
      if (createHash("sha256").update(old).digest("hex") !== expected)
        throw Error("Corrupt local immutable object: " + key);
      return old;
    }
    const data = await this.download(key);
    await this.save(path, data);
    return data;
  }
  private async range(path: string, offset: number, length: number) {
    const file = await open(path, "r");
    try {
      const data = Buffer.allocUnsafe(length);
      let at = 0;
      while (at < length) {
        const { bytesRead } = await file.read(
          data,
          at,
          length - at,
          offset + at,
        );
        if (!bytesRead) throw Error("Truncated local immutable file");
        at += bytesRead;
      }
      return data;
    } finally {
      await file.close();
    }
  }
  async read(key: string, offset: number, length: number): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (
      !object ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 1 ||
      offset + length > object.size
    )
      throw Error("Invalid local object range");
    try {
      return await this.range(this.path(key), offset, length);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    const path = `${this.dir}/ranges/${key}/${offset}-${length}.bin`;
    try {
      const data = await readFile(path);
      if (data.length !== length) throw Error("Truncated cached local range");
      return data;
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    const data = await this.download(key, offset, length);
    if (offset % PAGE || !object.checksums)
      throw Error("Preparation needs aligned checksummed pages");
    for (let at = 0; at < data.length; at += PAGE)
      if (
        crc32(data.subarray(at, at + PAGE)) !==
        object.checksums[(offset + at) / PAGE]
      )
        throw Error("Prepared page checksum mismatch");
    await this.save(path, data);
    return data;
  }
  async readPage(key: string, offset: number, length: number) {
    return {
      data: await this.read(key, offset, length),
      checksum: this.objects.get(key)?.checksums?.[offset / PAGE],
    };
  }
  async packageMetadata(key: string) {
    let task = this.packageReads.get(key);
    if (!task) {
      task = this.loadPackageMetadata(key);
      this.packageReads.set(key, task);
    }
    try {
      return await task;
    } finally {
      this.packageReads.delete(key);
    }
  }
  private async loadPackageMetadata(key: string) {
    let metadata = this.metadata.get(key);
    if (metadata) return metadata;
    const path = this.path(key) + ".json";
    try {
      metadata = JSON.parse(await readFile(path, "utf8"));
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      const data = await this.mirror(key),
        v = view(data);
      metadata = { first: v.getUint32(4, true), checksums: [] };
      for (let at = 0; at < data.length;) {
        if (
          at + 64 > data.length ||
          v.getUint32(at, true) !== 0x34504443 ||
          v.getUint32(at + 4, true) !==
            metadata.first + metadata.checksums.length
        )
          throw Error("Invalid local document group");
        const length = v.getUint32(at + 60, true);
        if (length < 64 || at + length > data.length)
          throw Error("Invalid local package length");
        metadata.checksums.push(crc32(data.subarray(at, at + length)));
        at += length;
      }
      await this.save(path, JSON.stringify(metadata));
    }
    this.metadata.set(key, metadata!);
    return metadata!;
  }
  async readWhole(
    key: string,
    range?: { offset: number; length: number; doc: number; first: number },
  ) {
    if (!range)
      throw Error("Local replay requires direct grouped package locators");
    if (
      ![range.offset, range.length, range.doc, range.first].every(
        Number.isSafeInteger,
      ) ||
      range.offset < 0 ||
      range.length < 64 ||
      range.length > 32 * 1048576 ||
      range.first < 0 ||
      range.doc < range.first ||
      range.doc >= this.root.count
    )
      throw Error("Invalid local package range");
    const path = `${this.dir}/ranges/${key}/${range.offset}-${range.length}.bin`;
    let data: Uint8Array | undefined,
      downloaded = false;
    try {
      data = await this.range(this.path(key), range.offset, range.length);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    if (!data) {
      try {
        data = await readFile(path);
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    if (!data) {
      data = await this.download(key, range.offset, range.length);
      downloaded = true;
      if (!this.metadata.has(key))
        throw Error("Package range response has no checksum metadata");
    }
    const metadata = await this.packageMetadata(key),
      checksum = metadata.checksums[range.doc - metadata.first];
    if (metadata.first !== range.first || checksum === undefined)
      throw Error("Local document group mismatch");
    if (data.length !== range.length)
      throw Error("Truncated local document range");
    if (downloaded) {
      if (crc32(data) !== checksum)
        throw Error("Prepared document checksum mismatch");
      await this.save(path, data);
    }
    return {
      data,
      checksum,
    };
  }
}
