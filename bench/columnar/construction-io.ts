/** Diagnostic wrapper around a frozen construction artifact. It changes no task
 * input, persisted acknowledgement or index bytes. Timings include overlapping
 * calls, with their union reported separately from their sum. */
export function constructionIO(core: {
  fetch(request: Request, env: any): Promise<Response>;
}) {
  return {
    async fetch(request: Request, env: any) {
      const started = performance.now(),
        intervals: [number, number][] = [],
        sums: Record<string, number> = {},
        counts: Record<string, number> = {};
      const timed = async (kind: string, action: () => Promise<any>) => {
        const at = performance.now();
        try {
          return await action();
        } finally {
          const end = performance.now();
          intervals.push([at, end]);
          sums[kind] = (sums[kind] ?? 0) + end - at;
          counts[kind] = (counts[kind] ?? 0) + 1;
        }
      };
      const bucket = new Proxy(env.INDEX, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (typeof value !== "function") return value;
            return async (...args: any[]) => {
              const result = await timed(String(key), () =>
                value.apply(target, args),
              );
              if (key !== "get" || !result) return result;
              return new Proxy(result, {
                get(object, field) {
                  const method = Reflect.get(object, field, object);
                  if (typeof method !== "function") return method;
                  return (...a: any[]) =>
                    timed("body", () => method.apply(object, a));
                },
              });
            };
          },
        }),
        response = await core.fetch(request, { ...env, INDEX: bucket });
      if (
        !response.ok ||
        !new URL(request.url).pathname.startsWith("/package-")
      )
        return response;
      const value = (await response.json()) as any;
      intervals.sort((a, b) => a[0] - b[0]);
      let unionMs = 0,
        end = started;
      for (const [a, b] of intervals) {
        unionMs += Math.max(0, b - Math.max(a, end));
        end = Math.max(end, b);
      }
      value.telemetry.io = {
        counts,
        sums,
        unionMs,
        wrapperWallMs: performance.now() - started,
      };
      console.log(JSON.stringify({ construction: value.telemetry }));
      return Response.json(value);
    },
  };
}
