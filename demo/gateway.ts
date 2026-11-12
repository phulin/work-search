import { page } from "./page.js";
import { parallel } from "../src/storage/types.js";
import { parse, queryTerms, QuerySyntaxError } from "../src/query/parser.js";
import { encodeCursor, decodeCursor } from "./cursor.js";
import { excerpt, opinionText, opinionInfo } from "../src/content/read.js";
interface Child {
  binding: string;
  min: number;
  max: number;
}
interface Env {
  INDEX: R2Bucket;
  INTERNAL_TOKEN: string;
  ROLE: string;
  CHILDREN: string;
  [key: string]: unknown;
}
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url),
      authorized =
        !!env.INTERNAL_TOKEN &&
        request.headers.get("authorization") === `Bearer ${env.INTERNAL_TOKEN}`,
      children: Child[] = JSON.parse(env.CHILDREN ?? "[]");
    const eligible = (c: Child, body: any) =>
      !body.generations ||
      Object.keys(body.generations).some(
        (k) => Number(k) >= c.min && Number(k) <= c.max,
      );
    const call = async (c: Child, path: string, body: any) => {
      const r = await (env[c.binding] as Fetcher).fetch(
        "https://internal" + path,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.INTERNAL_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      if (!r.ok)
        throw Object.assign(
          Error(`Index partition unavailable (${r.status})`),
          { status: r.status },
        );
      return (await r.json()) as any;
    };
    const stats = async (q: string) => {
      const rows = await parallel(children, 4, (c) =>
        call(c, "/internal/stats", { q }),
      );
      const out = {
        apiVersion: 2,
        count: 0,
        bodyTokens: 0,
        titleTokens: 0,
        df: {} as Record<string, number>,
        generations: {} as Record<string, string>,
      };
      for (const r of rows) {
        out.apiVersion = Math.min(out.apiVersion, r.apiVersion ?? 1);
        out.count += r.count;
        out.bodyTokens += r.bodyTokens;
        out.titleTokens += r.titleTokens;
        Object.assign(out.generations, r.generations);
        for (const [t, n] of Object.entries(r.df))
          out.df[t] = (out.df[t] ?? 0) + (n as number);
      }
      return out;
    };
    const search = async (body: any) => {
      const rows = await parallel(
        children.filter((c) => eligible(c, body)),
        4,
        (c) => call(c, "/internal/search", body),
      );
      return {
        results: rows
          .flatMap((r) => r.results)
          .sort(
            (a, b) => b.score - a.score || a.shard - b.shard || a.doc - b.doc,
          )
          .slice(0, body.limit),
      };
    };
    const documents = async (body: any) => {
      const rows = await parallel(
        children.filter((c) =>
          body.hits.some((h: any) => h.shard >= c.min && h.shard <= c.max),
        ),
        4,
        (c) => call(c, "/internal/documents", body),
      );
      return { results: rows.flatMap((r) => r.results) };
    };
    try {
      if (
        env.ROLE === "root" &&
        (url.pathname === "/" || url.pathname.startsWith("/opinion/"))
      )
        return new Response(page, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy":
              "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          },
        });
      if (env.ROLE === "root" && url.pathname === "/health") {
        const o = await env.INDEX.get("demo-status.json");
        return Response.json(
          o
            ? await o.json()
            : {
                documents: 0,
                complete: false,
                phase: "Preparing full import",
                snapshot: "2026-09-30",
              },
        );
      }
      if (env.ROLE === "root" && url.pathname === "/api/opinion/text") {
        const generation = url.searchParams.get("generation") ?? "",
          doc = Number(url.searchParams.get("doc"));
        return new Response(await opinionText(env.INDEX, generation, doc), {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "public,max-age=31536000,immutable",
          },
        });
      }
      if (env.ROLE === "root" && url.pathname === "/api/opinion/info") {
        const info = await opinionInfo(
          env.INDEX,
          url.searchParams.get("generation") ?? "",
          Number(url.searchParams.get("doc")),
        );
        const q = url.searchParams.get("q") ?? "";
        return Response.json(
          { ...info, terms: q.length <= 2048 ? queryTerms(parse(q)) : [] },
          { headers: { "cache-control": "public,max-age=3600" } },
        );
      }
      if (env.ROLE === "root" && url.pathname === "/api/search") {
        let input: any = {
          q: url.searchParams.get("q"),
          limit: url.searchParams.get("limit"),
        };
        if (request.method === "POST") {
          const reader = request.body?.getReader();
          let bytes = 0,
            text = "";
          const decoder = new TextDecoder();
          if (reader)
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              bytes += value.length;
              if (bytes > 262144) {
                await reader.cancel();
                return new Response("Search request too large", {
                  status: 413,
                });
              }
              text += decoder.decode(value, { stream: true });
            }
          input = JSON.parse(text);
        }
        const q = input.q ?? "",
          limit = Number(input.limit ?? 20);
        if (
          typeof q !== "string" ||
          q.length > 2048 ||
          !q.trim() ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 50
        )
          return Response.json(
            { error: "Enter a query and a limit from 1 to 50." },
            { status: 400 },
          );
        if (!children.length)
          return Response.json(
            { error: "The first index partition is being prepared." },
            { status: 503 },
          );
        const terms = queryTerms(parse(q)),
          start = Date.now();
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const cursor = input.cursor
              ? await decodeCursor(input.cursor, env.INTERNAL_TOKEN)
              : null;
            if (cursor && cursor.q !== q)
              return Response.json(
                { error: "Cursor belongs to another query" },
                { status: 400 },
              );
            const s = cursor ? null : await stats(q),
              globalStats = cursor?.globalStats ?? {
                count: s!.count,
                avgBody: s!.bodyTokens / (s!.count || 1),
                avgTitle: s!.titleTokens / (s!.count || 1),
                df: s!.df,
              },
              generations = cursor?.generations ?? s!.generations;
            const found = await search({
                q,
                limit: limit + 1,
                globalStats,
                generations,
                after: cursor?.after,
              }),
              hits = found.results.slice(0, limit),
              details = await documents({ hits, generations }),
              by = new Map(
                details.results.map((r: any) => [`${r.shard}:${r.doc}`, r]),
              );
            const snippets = await parallel(hits, 4, (h: any) =>
              excerpt(env.INDEX, generations[h.shard], h.doc, terms).catch(
                () => null,
              ),
            );
            const paginationReady = cursor || s!.apiVersion >= 2,
              hasMore = found.results.length > limit,
              last = hits.at(-1);
            const nextCursor =
              hasMore && paginationReady
                ? await encodeCursor(
                    {
                      q,
                      globalStats,
                      generations,
                      after: {
                        score: last.score,
                        shard: last.shard,
                        doc: last.doc,
                      },
                      expires: cursor?.expires ?? Date.now() + 3600000,
                    },
                    env.INTERNAL_TOKEN,
                  )
                : null;
            return Response.json(
              {
                results: hits.map((h: any, i: number) => {
                  const d: any = by.get(`${h.shard}:${h.doc}`);
                  return {
                    id: h.id,
                    score: h.score,
                    title: d?.title,
                    metadata: d?.metadata,
                    generation: generations[h.shard],
                    doc: h.doc,
                    excerpt: snippets[i],
                  };
                }),
                terms,
                nextCursor,
                paginationReady: !!paginationReady,
                milliseconds: Date.now() - start,
                documents: globalStats.count,
              },
              { headers: { "cache-control": "no-store" } },
            );
          } catch (e) {
            if (attempt === 0 && (e as any).status === 409 && !input.cursor)
              continue;
            throw e;
          }
        }
      }
      if (!authorized) return new Response("Not found", { status: 404 });
      if (env.ROLE === "root" && url.pathname.startsWith("/__index/")) {
        const gen = url.pathname.slice(9);
        if (!/^[a-f0-9]{64}$/.test(gen))
          return new Response("Invalid generation", { status: 400 });
        const o = await env.INDEX.get(gen + "/bundle-0.bin");
        return o
          ? new Response(o.body)
          : new Response("Missing bundle", { status: 404 });
      }
      if (
        env.ROLE === "root" &&
        url.pathname.startsWith("/__upload/") &&
        request.method === "PUT"
      ) {
        const key = decodeURIComponent(url.pathname.slice(10));
        if (!/^[a-f0-9]{64}\/[a-z]+-\d+\.bin$/.test(key))
          return new Response("Invalid key", { status: 400 });
        const sha = request.headers.get("x-sha256") ?? "",
          generation = key.split("/")[0],
          size = Number(request.headers.get("content-length"));
        if (!/^[a-f0-9]{64}$/.test(sha))
          return new Response("Missing hash", { status: 400 });
        const old = await env.INDEX.head(key);
        if (old) {
          if (
            old.size !== size ||
            old.customMetadata?.sha256 !== sha ||
            old.customMetadata?.generation !== generation
          )
            return new Response("Immutable conflict", { status: 409 });
          return new Response("Exists");
        }
        await env.INDEX.put(key, request.body, {
          customMetadata: { sha256: sha, generation },
        });
        return new Response("Stored");
      }
      if (
        env.ROLE === "root" &&
        url.pathname === "/__status" &&
        request.method === "PUT"
      ) {
        const text = await request.text();
        JSON.parse(text);
        await env.INDEX.put("demo-status.json", text);
        return new Response("Updated");
      }
      const body = (await request.json()) as any;
      if (url.pathname === "/internal/stats")
        return Response.json(await stats(body.q));
      if (url.pathname === "/internal/search")
        return Response.json(await search(body));
      if (url.pathname === "/internal/documents")
        return Response.json(await documents(body));
      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return Response.json(
        { error: e instanceof Error ? e.message : "Search unavailable" },
        {
          status:
            e instanceof QuerySyntaxError
              ? 400
              : (e as any).status === 409
                ? 409
                : 503,
        },
      );
    }
  },
};
