import { BinaryIndex } from "../format/index.js";
import { search, type SearchOptions } from "../query/engine.js";
import type { Storage } from "../storage/types.js";
export function handler(
  index: BinaryIndex,
  storage: Storage,
  diagnostics = false,
) {
  return async (request: Request) => {
    const url = new URL(request.url);
    if (request.method !== "GET")
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    if (url.pathname === "/health")
      return Response.json({
        status: "ok",
        generation: index.generation,
        documents: index.count,
        format: 1,
      });
    if (url.pathname !== "/search")
      return Response.json({ error: "Not found" }, { status: 404 });
    const p = url.searchParams,
      mode = p.get("mode") ?? "and",
      field = p.get("field") ?? "all",
      limit = Number(p.get("limit") ?? 20),
      titleBoost = Number(p.get("titleBoost") ?? 2);
    if (
      !["and", "or"].includes(mode) ||
      !["all", "title", "body"].includes(field) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isFinite(titleBoost) ||
      titleBoost < 0 ||
      titleBoost > 20 ||
      (p.get("q") ?? "").length > 2048
    )
      return Response.json(
        { error: "Invalid query parameters" },
        { status: 400 },
      );
    try {
      const result = await search(index, storage, p.get("q") ?? "", {
        mode,
        field,
        limit,
        titleBoost,
        metadata: p.get("metadata") === "true",
      } as SearchOptions);
      if (!diagnostics || p.get("diagnostics") !== "true") {
        const { diagnostics: _, ...publicResult } = result;
        return Response.json(publicResult);
      }
      return Response.json(result);
    } catch (e) {
      if (e instanceof Error && e.message === "At most 16 distinct query terms")
        return Response.json({ error: e.message }, { status: 400 });
      console.error(e);
      return Response.json({ error: "Search unavailable" }, { status: 503 });
    }
  };
}
