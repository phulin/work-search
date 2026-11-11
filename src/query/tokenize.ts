export function tokenize(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}
export interface Document {
  id: string;
  body: string;
  title?: string;
  metadata?: unknown;
}
export function parseQuery(q: string) {
  if (q.length > 2048) throw new Error("Query too long");
  const terms = [...new Set(tokenize(q))];
  if (terms.length > 16) throw new Error("At most 16 distinct query terms");
  return terms;
}
