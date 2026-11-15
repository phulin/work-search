import { scanText } from "./text.js";
import type { Analysis } from "../../query/analysis.js";
import type { PackageDocument } from "../document-package.js";

export interface NumericDocument {
  doc: number;
  body: Uint32Array;
  title: Uint32Array;
}
export interface AnalyzedDocument {
  document: PackageDocument;
  text: string;
  starts: Uint32Array;
  words: string[];
  body: Uint32Array;
  title: Uint32Array;
  retainedBytes: number;
}
/** Local token identities avoid retaining a string per occurrence. Both fields
 * are analyzed exactly once; display spans still refer to NFKC body text. */
export function analyzeDocument(
  document: PackageDocument,
  analysis?: Analysis,
): AnalyzedDocument {
  const words: string[] = [],
    ranks = new Map<string, number>(),
    starts: number[] = [],
    fields: Uint32Array[] = [];
  const body = scanText(document.body, analysis),
    title = scanText(document.title ?? "", analysis);
  const encoder = new TextEncoder(),
    decoder = new TextDecoder();
  for (const [field, scan] of [body, title].entries()) {
    const values: number[] = [];
    for (const token of scan.tokens()) {
      let rank = ranks.get(token.word);
      if (rank === undefined) {
        // Detach substring keys from the document's large string backing.
        const word = decoder.decode(encoder.encode(token.word));
        rank = words.length;
        ranks.set(word, rank);
        words.push(word);
      }
      values.push(rank);
      if (!field) starts.push(token.start);
    }
    fields.push(Uint32Array.from(values));
  }
  return {
    document,
    text: body.text,
    starts: Uint32Array.from(starts),
    words,
    body: fields[0],
    title: fields[1],
    retainedBytes:
      (document.body.length +
        body.text.length +
        (document.title?.length ?? 0)) *
        2 +
      words.reduce((n, w) => n + 64 + w.length * 2, 0) +
      (fields[0].length * 2 + fields[1].length) * 4,
  };
}
export function resolveDocument(
  input: AnalyzedDocument,
  ids: Map<string, number>,
): NumericDocument {
  const local = Uint32Array.from(input.words, (word) => {
    const id = ids.get(word);
    if (id === undefined || !Number.isInteger(id) || id < 0 || id > 0xffffffff)
      throw Error("Document vocabulary missing a token");
    return id;
  });
  return {
    doc: input.document.doc,
    body: Uint32Array.from(input.body, (n) => local[n]),
    title: Uint32Array.from(input.title, (n) => local[n]),
  };
}
