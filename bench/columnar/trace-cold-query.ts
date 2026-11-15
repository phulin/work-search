/** Diagnostic only: tag real Reader operations without changing serving code.
 * Interval unions overlap CPU and other categories; they are not additive
 * critical-path attribution. Run separately from latency measurements. */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  Reader,
  Memory,
  Lru,
  type Source,
} from "../../src/columnar/storage.js";
import type { ColumnarIndex, Options } from "../../src/columnar/search.js";
import type { Root, Ref, Branch } from "../../src/columnar/format.js";
import type { DirectoryTerm } from "../../src/columnar/term-directory.js";
import { SimulatedIO } from "./latency-model.js";
type Event = {
  kind: string;
  phase: string;
  start: number;
  end: number;
  bytes: number;
  key?: string;
};
export async function traceColdQuery(
  index: ColumnarIndex,
  root: Root,
  base: Source,
  q: string,
  options: Options,
) {
  const scope = new AsyncLocalStorage<string>(),
    events: Event[] = [],
    slots: { phase: string; requested: number; start: number; end: number }[] =
      [],
    io = new SimulatedIO(
      base,
      {
        r2Ms: 20,
        sharedMs: 2,
        r2MiBPerSecond: 100,
        sharedMiBPerSecond: 1000,
        jitterMs: 0,
        seed: 20261113,
      },
      256,
    ),
    deferred: Promise<unknown>[] = [],
    memory = new Memory();
  memory.pages = new Lru(12 * 1048576);
  index.directory?.clear();
  const begin = performance.now();
  const timed = async <T>(
    kind: string,
    key: string,
    bytes: number,
    f: () => Promise<T>,
  ) => {
    const phase = scope.getStore() ?? "other",
      start = performance.now() - begin;
    const result = await f();
    if (!bytes && result && typeof result === "object") {
      const value = result as any;
      bytes = value.byteLength ?? value.data?.byteLength ?? 0;
    }
    events.push({
      kind,
      phase,
      key,
      bytes,
      start,
      end: performance.now() - begin,
    });
    return result;
  };
  const source: Source = {
      read: (key, at, n) =>
        timed("origin", key + "@" + at, n, () => io.source.read(key, at, n)),
      readNamed: io.source.readNamed
        ? (key, n) =>
            timed("origin", key, n, () => io.source.readNamed!(key, n))
        : undefined,
      readPage: io.source.readPage
        ? (key, at, n, sha) =>
            timed("origin", key + "@" + at, n, () =>
              io.source.readPage!(key, at, n, sha),
            )
        : undefined,
      readWhole: io.source.readWhole
        ? (key, range) =>
            timed(
              "origin",
              key + (range ? "@" + range.offset : ""),
              range?.length ?? 0,
              () => io.source.readWhole!(key, range),
            )
        : undefined,
    },
    reader = new Reader(
      root,
      source,
      memory,
      {
        get: (key) => timed("shared-get", key, 0, () => io.shared.get(key)),
        put: (key, value) =>
          timed("shared-put", key, value.length, () =>
            io.shared.put(key, value),
          ),
      },
      "cold-trace",
      (p) => deferred.push(p),
    );
  const refs = new Map<string, string>(),
    r = reader as any,
    register = (ref: Ref | undefined, phase: string) => {
      if (ref?.[2]) refs.set(reader.key(ref), phase);
    },
    branch = (b: Branch) => {
      register(b.score, b.height ? "planning" : "score");
      if (!b.height) register(b.positions, "word-positions");
    },
    runAs = <T>(phase: string, f: () => T) => scope.run(phase, f),
    wrap = (name: string, phase: string) => {
      const original = r[name].bind(reader);
      r[name] = (...args: any[]) => runAs(phase, () => original(...args));
    };
  for (const name of ["scores", "prefetchScores"]) wrap(name, "score");
  wrap("positions", "word-positions");
  wrap("json", "presentation");
  const branches = reader.branches.bind(reader);
  r.branches = (ref: Ref) =>
    runAs("planning", async () => {
      const out = await branches(ref);
      for (const b of out) branch(b);
      return out;
    });
  for (const name of ["read", "packet"]) {
    const original = r[name].bind(reader);
    r[name] = (ref: Ref) =>
      runAs(scope.getStore() ?? refs.get(reader.key(ref)) ?? "other", () =>
        original(ref),
      );
  }
  const packets = reader.packets.bind(reader);
  r.packets = (ranges: Ref[], adjacentPages = false) =>
    runAs(
      scope.getStore() ??
        ranges.map((ref) => refs.get(reader.key(ref))).find(Boolean) ??
        "other",
      () => packets(ranges, adjacentPages),
    );
  const named = reader.named.bind(reader);
  r.named = (key: string, n: number) =>
    runAs(
      scope.getStore() ??
        (key.includes("/positions-")
          ? "pair-context"
          : key.includes("/pairs-")
            ? "pair-membership"
            : key.includes("presence")
              ? "presence"
              : "other"),
      () => named(key, n),
    );
  const document = reader.document.bind(reader),
    packages = new WeakSet<object>();
  r.document = (...args: Parameters<Reader["document"]>) =>
    runAs(args[4] ? "presentation" : "verification", async () => {
      const pkg = await document(...args);
      if (!packages.has(pkg)) {
        packages.add(pkg);
        for (const name of ["display", "preparePresentation", "snippet"]) {
          const p = pkg as any,
            original = p[name].bind(pkg);
          p[name] = (...args: any[]) =>
            runAs("presentation", () => original(...args));
        }
      }
      return pkg;
    });
  const terms = index.terms;
  index.terms = (...args: Parameters<ColumnarIndex["terms"]>) =>
    runAs("term-directory", async () => {
      const out = await terms.apply(index, args);
      for (const raw of out.values()) {
        const t = raw as DirectoryTerm;
        for (const ref of [t.frequencies, ...(t.frequencyParts ?? [])])
          register(ref, "term-frequencies");
        for (const ref of [t.positional, ...(t.positionalParts ?? [])])
          register(ref, "word-positions");
        if (t.tree) branch(t.tree);
      }
      return out;
    });
  const semaphore = reader.io.run.bind(reader.io);
  reader.io.run = <T>(f: () => Promise<T>) => {
    const phase = scope.getStore() ?? "other",
      requested = performance.now() - begin;
    return semaphore(async () => {
      const start = performance.now() - begin;
      try {
        return await f();
      } finally {
        slots.push({ phase, requested, start, end: performance.now() - begin });
      }
    });
  };
  let result: Awaited<ReturnType<ColumnarIndex["search"]>>, wallMs: number;
  const cpu = process.cpuUsage();
  try {
    result = await index.search(q, reader, options);
    JSON.stringify(result);
    wallMs = performance.now() - begin;
    await Promise.all(deferred);
  } finally {
    index.terms = terms;
  }
  const usage = process.cpuUsage(cpu);
  const union = (xs: { start: number; end: number }[]) => {
    let end = 0,
      total = 0;
    for (const x of xs.sort((a, b) => a.start - b.start)) {
      const hi = Math.min(wallMs, x.end),
        lo = Math.min(wallMs, x.start);
      if (hi > end) {
        total += hi - Math.max(lo, end);
        end = hi;
      }
    }
    return total;
  };
  const phases = Object.fromEntries(
    [...new Set(events.map((e) => e.phase))].map((phase) => {
      const es = events.filter((e) => e.phase === phase && e.start < wallMs),
        origin = es.filter((e) => e.kind === "origin"),
        ss = slots.filter((s) => s.phase === phase);
      return [
        phase,
        {
          originReads: origin.length,
          originBytes: origin.reduce((n, e) => n + e.bytes, 0),
          originActiveUnionMs: union(origin),
          storageActiveUnionMs: union(es),
          cumulativeSlotWaitMs: ss.reduce(
            (n, s) => n + s.start - s.requested,
            0,
          ),
        },
      ];
    }),
  );
  return {
    q,
    options,
    wallMs,
    processCpuMs: (usage.user + usage.system) / 1000,
    phases,
    originActiveUnionMs: union(events.filter((e) => e.kind === "origin")),
    storageActiveUnionMs: union(events),
    note: "Instrumented local diagnostic, not benchmark latency. Category intervals overlap; cumulative slot waits overlap and cannot be added to wall time. CPU includes deferred cache completion.",
    diagnostics: result!.diagnostics,
    result: result!,
    events,
    slots,
  };
}
