// Client-side measurements executed in a placed Worker, independent from the
// engine Worker. These are data-center client latencies, not browser last mile.
export default {
  async fetch(request: Request, env: { INTERNAL_TOKEN: string }) {
    if (request.headers.get("authorization") !== `Bearer ${env.INTERNAL_TOKEN}`)
      return new Response("Not found", { status: 404 });
    if (new URL(request.url).pathname === "/health") {
      const trace = await fetch(
        "https://www.cloudflare.com/cdn-cgi/trace",
      ).then((r) => r.text());
      const fields = Object.fromEntries(
        trace
          .trim()
          .split("\n")
          .map((l) => l.split("=")),
      );
      return Response.json(
        {
          requestColo: (request as any).cf?.colo,
          egressTrace: {
            colo: fields.colo,
            loc: fields.loc,
            http: fields.http,
          },
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    const input = (await request.json()) as {
      name: string;
      q: string;
      options?: Record<string, unknown>;
      requestId?: string;
    };
    if (
      !/^work-search-cws-(control|v\d+|1m)$/.test(input.name) ||
      typeof input.q !== "string"
    )
      return Response.json(
        { error: "Invalid benchmark target" },
        { status: 400 },
      );
    const start = performance.now(),
      r = await fetch(
        `https://${input.name}.phulin.workers.dev/search?requestId=${input.requestId ?? crypto.randomUUID()}&q=${encodeURIComponent(input.q)}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.INTERNAL_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ q: input.q, ...input.options }),
        },
      ),
      text = await r.text(),
      body = (() => {
        try {
          return JSON.parse(text);
        } catch {
          return { error: `Upstream HTTP ${r.status}: ${text.slice(0, 500)}` };
        }
      })(),
      ms = performance.now() - start;
    return Response.json(
      {
        clientMs: ms,
        status: r.status,
        clientRequestColo: (request as any).cf?.colo,
        body,
      },
      { headers: { "cache-control": "no-store" } },
    );
  },
};
