export interface LatencySample {
  headersMs: number;
  bodyMs: number;
  bytes: number;
  round: number;
  concurrency: number;
  cohort: string;
}
export class Random {
  constructor(private state: number) {}
  next() {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 4294967296;
  }
  pick<T>(items: T[]) {
    if (!items.length) throw Error("Empty empirical distribution");
    return items[Math.floor(this.next() * items.length)];
  }
}
export class Slots {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(readonly capacity = 6) {}
  async acquire() {
    if (this.active >= this.capacity)
      await new Promise<void>((r) => this.queue.push(r));
    else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    };
  }
}
export const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();
const sizes = [16, 1024, 16384, 65536, 262144, 1048576];
const bin = (n: number) =>
  sizes.reduce(
    (best, size, i) =>
      Math.abs(Math.log2(Math.max(1, n) / size)) <
      Math.abs(Math.log2(Math.max(1, n) / sizes[best]))
        ? i
        : best,
    0,
  );
export class EmpiricalModel {
  private rng: Random;
  private round: number;
  constructor(
    private samples: LatencySample[],
    seed: number,
    readonly mode: "empirical" | "fixed20" | "none" = "empirical",
    cohort = "varied-range",
  ) {
    this.rng = new Random(seed);
    this.round = this.rng.pick([...new Set(samples.map((s) => s.round))]);
    const serial = samples.filter(
      (s) => s.concurrency === 1 && s.cohort === cohort,
    );
    if (!serial.length && mode === "empirical")
      throw Error("No serial R2 calibration observations");
    this.samples = serial;
  }
  sample(bytes: number) {
    if (this.mode === "none") return { headersMs: 0, bodyMs: 0 };
    if (this.mode === "fixed20") return { headersMs: 20, bodyMs: 0 };
    let rows = this.samples.filter(
      (s) => s.round === this.round && bin(s.bytes) === bin(bytes),
    );
    if (!rows.length)
      rows = this.samples.filter((s) => bin(s.bytes) === bin(bytes));
    const s = this.rng.pick(rows.length ? rows : this.samples);
    // Header/body remain a measured pair. Body time scales within size strata;
    // no additional bandwidth delay is added on top of the measured transfer.
    return {
      headersMs: s.headersMs,
      bodyMs: (s.bodyMs * bytes) / Math.max(1, s.bytes),
    };
  }
}
