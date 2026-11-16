import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { Source } from "../../src/columnar/storage.js";
import type { Root } from "../../src/columnar/format.js";

/** Preparation binds authenticated immutable range responses to local SHA-256
 * receipts. Timed runs have no network and do no checksum work. */
export class RangeStorage implements Source {
  prepare = false;
  reads = 0;
  bytes = 0;
  localAssemblies = 0;
  private pending = new Map<string, Promise<Uint8Array>>();
  private expected = new Map<string, { sha256: string; size: number }>();
  private receipts = new Map<
    string,
    { file: string; sha256: string; bytes: number; key: string; offset: number }
  >();
  constructor(
    readonly root: Root,
    readonly directory: string,
    readonly remote?: { url: string; token: string },
  ) {
    for (const o of [
      ...root.objects,
      ...(root.pairMembership?.objects ?? []),
      ...(root.metadataObjects ?? []),
    ])
      this.expected.set(o.key ?? root.generation + "/" + (o as any).name, o);
  }
  private async fetchRange(
    key: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    const inventory = this.expected.get(key),
      generation = key.split("/")[0],
      expected =
        inventory?.sha256 ??
        (/^([a-f0-9]{64})\/plan-\d+\.bin$/.test(key) ? generation : undefined);
    if (
      !expected ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      (inventory && offset + length > inventory.size)
    )
      throw Error("Invalid prepared immutable range");
    const id = key + ":" + offset + ":" + length,
      file = createHash("sha256").update(id).digest("hex"),
      path = this.directory + "/" + file;
    const old = await readFile(path).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    if (old) {
      if (old.length !== length) throw Error("Truncated prepared range");
      if (!this.prepare && !this.receipts.has(file))
        throw Error("Prepared range lacks a verified receipt");
      return old;
    }
    if (!this.prepare) {
      // Coalescing can request a different extent when asynchronous cache
      // completion changes. Assemble it only from already-verified local
      // coverage; timed queries must never download a missing range.
      const spans = [...this.receipts.values()]
          .filter(
            (r) =>
              r.key === key &&
              r.offset < offset + length &&
              r.offset + r.bytes > offset,
          )
          .sort((a, b) => a.offset - b.offset || b.bytes - a.bytes),
        selected: typeof spans = [];
      let end = offset;
      for (let i = 0; end < offset + length;) {
        let best: (typeof spans)[number] | undefined;
        while (i < spans.length && spans[i].offset <= end) {
          const span = spans[i++];
          if (
            span.offset + span.bytes >
            (best ? best.offset + best.bytes : end)
          )
            best = span;
        }
        if (!best) break;
        selected.push(best);
        end = best.offset + best.bytes;
      }
      if (end >= offset + length) {
        const data = Buffer.allocUnsafe(length);
        let at = offset;
        for (const span of selected) {
          const raw = await readFile(this.directory + "/" + span.file),
            end = Math.min(offset + length, span.offset + span.bytes);
          if (raw.length !== span.bytes)
            throw Error("Truncated verified range");
          raw.copy(data, at - offset, at - span.offset, end - span.offset);
          at = end;
        }
        this.localAssemblies++;
        return data;
      }
    }
    if (!this.prepare || !this.remote)
      throw Error("Missing prepared range: " + id);
    for (let attempt = 0; ; attempt++)
      try {
        const r = await fetch(this.remote.url + "/" + key, {
          headers: {
            authorization: `Bearer ${this.remote.token}`,
            "x-offset": String(offset),
            "x-length": String(length),
          },
          signal: AbortSignal.timeout(180000),
        });
        if (
          !r.ok ||
          r.headers.get("x-sha256") !== expected ||
          r.headers.get("x-generation") !== generation
        )
          throw Error("Prepared range identity mismatch: " + r.status);
        const data = Buffer.from(await r.arrayBuffer());
        if (data.length !== length)
          throw Error("Truncated prepared range response");
        const receipt = {
          file,
          sha256: createHash("sha256").update(data).digest("hex"),
          bytes: length,
          key,
          offset,
        };
        await mkdir(this.directory, { recursive: true });
        const temp = path + "." + randomUUID();
        await writeFile(temp, data);
        await rename(temp, path);
        await writeFile(path + ".json", JSON.stringify(receipt));
        this.receipts.set(file, receipt);
        this.reads++;
        this.bytes += length;
        return data;
      } catch (error) {
        if (attempt === 5) throw error;
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
  }
  async read(key: string, offset: number, length: number) {
    const id = key + ":" + offset + ":" + length;
    let task = this.pending.get(id);
    if (!task) {
      task = this.fetchRange(key, offset, length);
      this.pending.set(id, task);
    }
    try {
      return await task;
    } finally {
      this.pending.delete(id);
    }
  }
  async readPage(key: string, offset: number, length: number) {
    return { data: await this.read(key, offset, length) };
  }
  async readWhole(
    key: string,
    range?: { offset: number; length: number; doc: number; first: number },
  ) {
    if (!range) throw Error("Direct document locator required");
    const data = await this.read(key, range.offset, range.length),
      v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length < 64 || v.getUint32(4, true) !== range.doc)
      throw Error("Prepared document identity mismatch");
    return { data };
  }
  async readNamed(address: string, bytes: number) {
    const match = /^(.+)@(\d+)$/.exec(address);
    return this.read(
      match ? match[1] : address,
      match ? Number(match[2]) : 0,
      bytes,
    );
  }
  async verify() {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(this.directory).catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return [] as string[];
    });
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const r = JSON.parse(await readFile(this.directory + "/" + name, "utf8")),
        data = await readFile(this.directory + "/" + r.file);
      if (
        data.length !== r.bytes ||
        createHash("sha256").update(data).digest("hex") !== r.sha256
      )
        throw Error("Corrupt prepared range");
      this.receipts.set(r.file, r);
    }
    return {
      ranges: this.receipts.size,
      bytes: [...this.receipts.values()].reduce((n, r) => n + r.bytes, 0),
    };
  }
}
