import { mkdir, readFile, writeFile, rename, open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { Source } from "../../src/columnar/storage.js";
import type { Root } from "../../src/columnar/format.js";
interface RangeReceipt {
  file: string;
  sha256: string;
  bytes: number;
  key: string;
  offset: number;
}

/** Preparation binds authenticated immutable range responses to local SHA-256
 * receipts. Timed runs have no network and do no checksum work. */
export class RangeStorage implements Source {
  capture?: (range: { key: string; offset: number; length: number }) => void;
  prepare = false;
  reads = 0;
  bytes = 0;
  localAssemblies = 0;
  private pending = new Map<string, Promise<Uint8Array>>();
  private expected = new Map<string, { sha256: string; size: number }>();
  private completeInventory = new Set<string>();
  private accessed = new Set<string>();
  private byKey = new Map<string, RangeReceipt[]>();
  private receipts = new Map<string, RangeReceipt>();
  constructor(
    readonly root: Root,
    readonly directory: string,
    readonly remote?: { url: string; token: string },
  ) {
    for (const o of [...root.objects, ...(root.metadataObjects ?? [])]) {
      const key = o.key ?? root.generation + "/" + (o as any).name;
      this.expected.set(key, o);
      this.completeInventory.add(key);
    }
    for (const o of root.pairMembership?.objects ?? [])
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
      if (this.receipts.has(file)) return old;
      if (this.prepare) {
        const receipt = await readFile(path + ".json", "utf8").then(
          JSON.parse,
          () => undefined,
        );
        if (receipt) {
          if (
            receipt.file !== file ||
            receipt.key !== key ||
            receipt.offset !== offset ||
            receipt.bytes !== length ||
            receipt.sha256 !== createHash("sha256").update(old).digest("hex")
          )
            throw Error("Corrupt prepared range");
          this.receipts.set(file, receipt);
          return old;
        }
      }
      // Another preparation can add files after verify(). Ignore those files
      // during replay; only the receipt snapshot may supply timed data below.
    }
    {
      // Coalescing can request a different extent when asynchronous cache
      // completion changes. Assemble it only from already-verified local
      // coverage; timed queries must never download a missing range.
      const spans = (this.byKey.get(key) ?? [])
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
          const end = Math.min(offset + length, span.offset + span.bytes),
            handle = await open(this.directory + "/" + span.file, "r");
          try {
            if (
              (await handle.stat()).size !== span.bytes ||
              (await handle.read(data, at - offset, end - at, at - span.offset))
                .bytesRead !==
                end - at
            )
              throw Error("Truncated verified range");
          } finally {
            await handle.close();
          }
          at = end;
        }
        this.localAssemblies++;
        if (this.prepare) {
          const receipt = {
            file,
            sha256: createHash("sha256").update(data).digest("hex"),
            bytes: length,
            key,
            offset,
          };
          const temp = path + "." + randomUUID();
          await writeFile(temp, data);
          await rename(temp, path);
          await writeFile(path + ".json", JSON.stringify(receipt));
          this.receipts.set(file, receipt);
        }
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
    this.capture?.({ key, offset, length });
    this.accessed.add(key);
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
    this.byKey.clear();
    for (const receipt of this.receipts.values()) {
      let rows = this.byKey.get(receipt.key);
      if (!rows) this.byKey.set(receipt.key, (rows = []));
      rows.push(receipt);
    }
    return {
      ranges: this.receipts.size,
      bytes: [...this.receipts.values()].reduce((n, r) => n + r.bytes, 0),
    };
  }
  include(objects: Iterable<{ key: string; size: number; sha256: string }>) {
    for (const object of objects) {
      const old = this.expected.get(object.key);
      if (old && (old.size !== object.size || old.sha256 !== object.sha256))
        throw Error("Conflicting prepared object identity");
      this.expected.set(object.key, object);
      this.completeInventory.add(object.key);
    }
  }
  /** Keep the complete numeric/document inventory. Pair packets are selected
   * by query identity; retain whole touched packets without copying the much
   * larger complete pair index just to prepare a scheduling experiment. */
  async completePreparation(
    maxBytes = 32 * 1048576,
    onProgress?: (done: number, total: number, bytes: number) => void,
  ) {
    if (!this.prepare) throw Error("Complete objects outside preparation");
    const objects = [
      ...new Set([...this.completeInventory, ...this.accessed]),
    ].flatMap((key) => {
      const object = this.expected.get(key);
      return object && object.size > 0 && object.size <= maxBytes
        ? [{ key, ...object }]
        : [];
    });
    let next = 0,
      done = 0,
      bytes = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (;;) {
          const object = objects[next++];
          if (!object) break;
          const raw = await this.read(object.key, 0, object.size);
          if (createHash("sha256").update(raw).digest("hex") !== object.sha256)
            throw Error("Prepared whole-object digest mismatch");
          bytes += raw.length;
          onProgress?.(++done, objects.length, bytes);
        }
      }),
    );
    return { objects: objects.length, bytes };
  }
}
