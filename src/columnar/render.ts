import type { Root, Branch } from "./format.js";
import { refAt, view } from "./format.js";
import { queryTerms, type Node } from "../query/parser.js";
import type { Reader } from "./storage.js";
import type { Options } from "./search.js";
export interface ResultHit {
  doc: number;
  score: number;
  branch?: Branch;
  row: number;
  first?: number;
  titleOnly?: boolean;
}
export async function renderResults(
  root: Root,
  reader: Reader,
  ranked: ResultHit[],
  options: Options,
  ast: Node,
) {
  const displayStart = performance.now();
  const locators = await reader.many(
    ranked.map((h) =>
      h.branch?.locators[2]
        ? h.branch.locators
        : root.documents[Math.floor(h.doc / 4096)],
    ),
  );
  const results = await Promise.all(
    ranked.map(async (h, i) => {
      const v = view(locators[i]),
        p = (h.branch?.locators[2] ? h.row : h.doc % 4096) * 36,
        recordRef = refAt(v, p),
        forwardRef = refAt(v, p + 12);
      let snippetRef = refAt(v, p + 24);
      if (options.snippets !== false && h.first !== undefined) {
        const directory = view(await reader.read(forwardRef)),
          frame = Math.floor(h.first / 256);
        if ((frame + 1) * 32 > directory.byteLength)
          throw Error("Invalid forward frame");
        snippetRef = refAt(directory, frame * 32 + 20);
      }
      const [record, passage] = await Promise.all([
        reader.json(recordRef),
        options.snippets !== false && !h.titleOnly
          ? reader.json(snippetRef)
          : undefined,
      ]);
      let snippet: string | undefined;
      if (options.snippets !== false && h.titleOnly)
        snippet = String(record.title ?? "").slice(0, 400);
      if (passage) {
        let at = h.first === undefined ? -1 : h.first - passage.first;
        if (at < 0 || at >= passage.starts.length) {
          const ts = new Set(queryTerms(ast, true));
          const m =
            passage.text
              .normalize("NFKC")
              .toLowerCase()
              .match(/[\p{L}\p{N}]+/gu) ?? [];
          at = m.findIndex((t: string) => ts.has(t));
        }
        const from = at >= 0 ? Math.max(0, passage.starts[at] - 160) : 0,
          end = at >= 0 ? passage.ends[at] + 240 : 400;
        snippet =
          (passage.first || from ? "…" : "") +
          passage.text.slice(from, end).trim() +
          (end < passage.text.length ? "…" : "");
      }
      return {
        id: record.id,
        doc: h.doc,
        score: h.score,
        ...(options.metadata !== false
          ? { title: record.title, metadata: record.metadata }
          : {}),
        ...(snippet !== undefined ? { snippet } : {}),
      };
    }),
  );
  reader.stats.metadataMs = performance.now() - displayStart;

  return results;
}
