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
