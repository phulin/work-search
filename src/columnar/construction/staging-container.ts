import { BuildStore, type Chunk } from "./runs.js";
/** Logical refs are filled before finish resolves. Callers retain these exact
 * ref objects; none may be published before the container has been finished. */
export class StagingContainer {
  private parts: Uint8Array[] = [];
  private refs: Chunk[] = [];
  private bytes = 0;
  private tail = Promise.resolve();
  constructor(
    readonly store: BuildStore,
    readonly budget = 8 * 1048576,
  ) {}
  append(data: Uint8Array, metadata: Partial<Chunk> = {}): Promise<Chunk> {
    return this.serial(async () => {
      if (this.bytes && this.bytes + data.length > this.budget)
        await this.flushNow();
      const ref = { ...metadata, key: "", size: data.length, sha256: "" };
      this.parts.push(data);
      this.refs.push(ref);
      this.bytes += data.length;
      if (this.bytes >= this.budget) await this.flushNow();
      return ref;
    });
  }
  private serial<T>(f: () => Promise<T>) {
    const next = this.tail.then(f);
    this.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  flush() {
    return this.serial(() => this.flushNow());
  }
  private async flushNow() {
    if (!this.parts.length) return;
    const written = await this.store.putParts(this.parts);
    written.forEach((ref, i) => Object.assign(this.refs[i], ref));
    this.parts = [];
    this.refs = [];
    this.bytes = 0;
  }
}
