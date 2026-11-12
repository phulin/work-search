import { AsyncLocalStorage } from "node:async_hooks";
export interface IOEvent {
  type: "r2" | "service";
  key: string;
  offset?: number;
  length?: number;
  start: number;
  headers?: number;
  end?: number;
  bytes?: number;
  cancelled?: boolean;
  status?: number;
  payload?: any;
}
export interface Trace {
  start: number;
  events: IOEvent[];
  colo?: string;
}
export const context = new AsyncLocalStorage<Trace>();
const buckets = new WeakMap<R2Bucket, R2Bucket>();
export function tracedBucket(bucket: R2Bucket): R2Bucket {
  let wrapped = buckets.get(bucket);
  if (wrapped) return wrapped;
  wrapped = new Proxy(bucket, {
    get(target, prop) {
      if (prop !== "get") {
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      }
      return async (key: string, options?: any) => {
        const trace = context.getStore();
        if (!trace) return target.get(key, options);
        const event: IOEvent = {
          type: "r2",
          key,
          offset: options?.range?.offset,
          length: options?.range?.length,
          start: performance.now() - trace.start,
        };
        trace.events.push(event);
        const object = await target.get(key, options);
        event.headers = performance.now() - trace.start;
        if (!object) {
          event.end = event.headers;
          event.status = 404;
          return null;
        }
        event.status = 200;
        let body: ReadableStream | undefined;
        return new Proxy(object, {
          get(o, p) {
            if (p === "body") {
              if (!body) {
              const reader = (o as R2ObjectBody).body.getReader();
                event.bytes = 0;
                body = new ReadableStream({
                  async pull(controller) {
                    const r = await reader.read();
                    if (r.done) {
                      event.end = performance.now() - trace.start;
                      controller.close();
                    } else {
                      event.bytes! += r.value.byteLength;
                      controller.enqueue(r.value);
                    }
                  },
                  async cancel(reason) {
                    event.cancelled = true;
                    event.end = performance.now() - trace.start;
                    await reader.cancel(reason);
                  },
                });
              }
              return body;
            }
            if (["arrayBuffer", "json", "text"].includes(String(p)))
              return async () => {
                const value = await (o as any)[p]();
                event.end = performance.now() - trace.start;
                event.bytes =
                  value instanceof ArrayBuffer
                    ? value.byteLength
                    : new TextEncoder().encode(
                        typeof value === "string"
                          ? value
                          : JSON.stringify(value),
                      ).length;
                return value;
              };
            const value = Reflect.get(o, p);
            return typeof value === "function" ? value.bind(o) : value;
          },
        });
      };
    },
  }) as R2Bucket;
  buckets.set(bucket, wrapped);
  return wrapped;
}
export function tracedService(binding: Fetcher, name: string): Fetcher {
  return {
    fetch: async (url: string, init: RequestInit) => {
      const trace = context.getStore(),
        start = performance.now();
      const response = await binding.fetch(url, init);
      if (!trace) return response;
      const event: IOEvent = {
        type: "service",
        key: name + new URL(url).pathname,
        start: start - trace.start,
        headers: performance.now() - trace.start,
        status: response.status,
      };
      trace.events.push(event);
      return new Proxy(response, {
        get(r, p) {
          if (p === "json")
            return async () => {
              const value = await r.json();
              event.end = performance.now() - trace.start;
              if (new URL(url).pathname.endsWith("/stats"))
                event.payload = value;
              return value;
            };
          const value = Reflect.get(r, p);
          return typeof value === "function" ? value.bind(r) : value;
        },
      });
    },
  } as unknown as Fetcher;
}
