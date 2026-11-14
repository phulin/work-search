/** Observation-only wrapper for an isolated copy of the deployed runtime. */
import { AsyncLocalStorage } from "node:async_hooks";
type Event = {
  id: number;
  parent?: number;
  kind: string;
  start: number;
  end?: number;
  [key: string]: unknown;
};
type Trace = {
  start: number;
  end?: number;
  events: Event[];
  logical: Map<string, any>;
  dropped: number;
  enabled: boolean;
  continuations: unknown[];
};
const scope = new AsyncLocalStorage<{ trace: Trace; parent?: number }>();
export function noteContinuation(plan: unknown) {
  scope.getStore()?.trace.continuations.push(plan);
}
function span(
  kind: string,
  details: any,
  fn: () => any,
  note?: (value: any) => any,
): any {
  const state = scope.getStore();
  if (!state?.trace.enabled) return fn();
  const t = state.trace;
  if (t.events.length >= 15000) {
    t.dropped++;
    return fn();
  }
  const e: Event = {
    id: t.events.length,
    parent: state.parent,
    kind,
    start: performance.now() - t.start,
    ...details,
  };
  t.events.push(e);
  return scope.run({ trace: t, parent: e.id }, async () => {
    try {
      const value = await fn();
      if (note) Object.assign(e, note(value));
      return value;
    } catch (error) {
      e.error = String(error);
      throw error;
    } finally {
      e.end = performance.now() - t.start;
    }
  });
}
function logical(ref: any, keyFor: (r: any) => string) {
  const s = scope.getStore();
  if (!s?.trace.enabled || !Array.isArray(ref)) return;
  const key = keyFor(ref) + ":" + ref[1] + ":" + ref[2];
  if (!s.trace.logical.has(key))
    s.trace.logical.set(key, {
      key: keyFor(ref),
      offset: ref[1],
      length: ref[2],
      parent: s.parent,
    });
}
export function instrumentShared(shared: any) {
  if (!shared) return shared;
  return {
    get: (key: string) =>
      span(
        "cache.get",
        { key },
        () => shared.get(key),
        (data) => ({ hit: !!data, bytes: data?.length ?? 0 }),
      ),
    put: (key: string, data: Uint8Array) =>
      span("cache.put", { key, bytes: data.length }, () =>
        shared.put(key, data),
      ),
  };
}
export function installProfile(
  Reader: any,
  Semaphore: any,
  R2: any,
  keyFor: (r: any) => string,
) {
  for (const method of [
    "scores",
    "prefetchScores",
    "branches",
    "many",
    "document",
    "named",
  ]) {
    const old = Reader.prototype[method];
    Reader.prototype[method] = function (...args: any[]) {
      const kind =
        method === "scores" || method === "prefetchScores"
          ? "score"
          : method === "document"
            ? "document"
            : method === "named"
              ? String(args[0]).endsWith("/metadata.bin")
                ? "metadata"
                : String(args[0]).includes("/presence-")
                  ? "presence"
                  : "pair"
              : method === "many"
                ? "posting-read"
                : "branches";
      const details =
        method === "document"
          ? { doc: args[1], bytes: args[2]?.length }
          : method === "scores" || method === "prefetchScores"
            ? {
                blocks: args[0].length,
                logicalBytes: args[0].reduce(
                  (n: number, r: any) => n + r[2],
                  0,
                ),
              }
            : {};
      return span(kind, details, () => {
        if (kind === "score") for (const ref of args[0]) logical(ref, keyFor);
        return old.apply(this, args);
      });
    };
  }
  for (const method of ["read", "packet"]) {
    const old = Reader.prototype[method];
    Reader.prototype[method] = function (...args: any[]) {
      logical(args[0], keyFor);
      return old.apply(this, args);
    };
  }
  const run = Semaphore.prototype.run;
  Semaphore.prototype.run = function (fn: any) {
    return span(
      "io-slot",
      { active: this.active, waiting: this.waiting.length },
      () => run.call(this, () => span("io-service", {}, fn)),
    );
  };
  for (const method of ["readPage", "readNamed", "readWhole"]) {
    const old = R2.prototype[method];
    R2.prototype[method] = function (...args: any[]) {
      return span(
        "r2.get",
        {
          key: args[0],
          offset:
            method === "readPage"
              ? args[1]
              : method === "readWhole"
                ? (args[1]?.offset ?? 0)
                : 0,
          requested:
            method === "readPage"
              ? args[2]
              : method === "readWhole"
                ? args[1]?.length
                : args[1],
          type: method,
        },
        () => old.apply(this, args),
        (r) => ({ bytes: (r?.data ?? r)?.length ?? 0 }),
      );
    };
  }
}
export function profileWorker(base: any) {
  return {
    async fetch(request: Request, env: any, ctx: ExecutionContext) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return base.fetch(request, env, ctx);
      if (
        !env.INTERNAL_TOKEN ||
        request.headers.get("authorization") !== `Bearer ${env.INTERNAL_TOKEN}`
      )
        return new Response("Not found", { status: 404 });
      const repeated = url.pathname === "/__capture",
        input: any = repeated ? await request.json() : undefined;
      const trace: Trace = {
        start: performance.now(),
        events: [],
        logical: new Map(),
        dropped: 0,
        enabled: !repeated,
        continuations: [],
      };
      return scope.run({ trace }, async () => {
        if (repeated) {
          const duration = Math.min(
              45000,
              Math.max(1000, Number(input.durationMs ?? 40000)),
            ),
            results: any[] = [];
          do {
            const response = await base.fetch(
              new Request(url.origin + "/search", {
                method: "POST",
                headers: request.headers,
                body: JSON.stringify({
                  ...input,
                  durationMs: undefined,
                  resetMemory: results.length === 0 && !!input.resetMemory,
                }),
              }),
              env,
              ctx,
            );
            const result = await response.json();
            results.push({
              status: response.status,
              telemetry: (result as any).telemetry,
              diagnostics: (result as any).diagnostics,
            });
            if (response.status !== 200) break;
          } while (performance.now() - trace.start < duration);
          return Response.json({
            calls: results.length,
            elapsedMs: performance.now() - trace.start,
            results,
          });
        }
        const response = await base.fetch(request, env, ctx);
        trace.end = performance.now() - trace.start;
        const result: any = await response.json();
        return Response.json(
          {
            ...result,
            liveProfile: {
              elapsedMs: trace.end,
              events: trace.events,
              logical: [...trace.logical.values()],
              continuations: trace.continuations,
              dropped: trace.dropped,
              clock:
                "Worker performance.now; native CPU measured separately. Pending background writes may lack end timestamps.",
            },
          },
          { status: response.status, headers: { "cache-control": "no-store" } },
        );
      });
    },
  };
}
