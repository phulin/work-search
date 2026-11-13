import {
  Lru,
  type Source,
  type SharedPages,
} from "../../src/columnar/storage.js";

export interface LatencyModel {
  r2Ms: number;
  sharedMs: number;
  r2MiBPerSecond: number;
  sharedMiBPerSecond: number;
  jitterMs: number;
  seed: number;
}
/** Delays happen at the real Reader's storage boundary, inside its six-slot
 * scheduling. Overlapping GETs overlap; dependent fetches remain dependent. */
export class SimulatedIO {
  delaysEnabled = true;
  private randomState: number;
  readonly sharedBytes: Lru<Uint8Array>;
  readonly source: Source;
  readonly shared: SharedPages;
  calls = {
    r2: 0,
    sharedGet: 0,
    sharedPut: 0,
    r2Bytes: 0,
    sharedGetBytes: 0,
    sharedPutBytes: 0,
    requestedServiceMs: 0,
  };
  constructor(
    base: Source,
    readonly model: LatencyModel,
    sharedMiB = 256,
  ) {
    for (const n of Object.values(model))
      if (!Number.isFinite(n) || n < 0) throw Error("Invalid latency model");
    if (
      !model.r2MiBPerSecond ||
      !model.sharedMiBPerSecond ||
      !Number.isFinite(sharedMiB) ||
      sharedMiB <= 0
    )
      throw Error("Invalid modeled bandwidth or cache capacity");
    this.randomState = model.seed || 1;
    this.sharedBytes = new Lru(sharedMiB * 1048576);
    this.source = {
      readNamed: base.readNamed
        ? async (key, bytes) => {
            this.calls.r2++;
            this.calls.r2Bytes += bytes;
            await this.pause("r2", bytes);
            return base.readNamed!(key, bytes);
          }
        : undefined,
      read: async (key, offset, length) => {
        this.calls.r2++;
        this.calls.r2Bytes += length;
        await this.pause("r2", length);
        return base.read(key, offset, length);
      },
      readPage: base.readPage
        ? async (key, offset, length, sha) => {
            this.calls.r2++;
            this.calls.r2Bytes += length;
            await this.pause("r2", length);
            return base.readPage!(key, offset, length, sha);
          }
        : undefined,
      readWhole: base.readWhole
        ? async (key, range) => {
            this.calls.r2++;
            await this.pause("r2", range?.length ?? 0);
            const result = await base.readWhole!(key, range);
            this.calls.r2Bytes += result.data.length;
            return result;
          }
        : undefined,
    };
    this.shared = {
      get: async (key) => {
        this.calls.sharedGet++;
        const data = this.sharedBytes.get(key);
        this.calls.sharedGetBytes += data?.length ?? 0;
        await this.pause("shared", data?.length ?? 0);
        return data ? Uint8Array.from(data) : undefined;
      },
      put: async (key, value) => {
        this.calls.sharedPut++;
        this.calls.sharedPutBytes += value.length;
        await this.pause("shared", value.length);
        this.sharedBytes.set(key, Uint8Array.from(value), value.length);
      },
    };
  }
  private async pause(kind: "r2" | "shared", bytes: number) {
    if (!this.delaysEnabled) return;
    let x = this.randomState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.randomState = x;
    const ms =
      (kind === "r2" ? this.model.r2Ms : this.model.sharedMs) +
      (bytes /
        1048576 /
        (kind === "r2"
          ? this.model.r2MiBPerSecond
          : this.model.sharedMiBPerSecond)) *
        1000 +
      (kind === "r2" ? ((x >>> 0) / 4294967296) * this.model.jitterMs : 0);
    this.calls.requestedServiceMs += ms;
    if (ms) await new Promise((r) => setTimeout(r, ms));
  }
}
