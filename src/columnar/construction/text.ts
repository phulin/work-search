/** Offsets into NFKC display text, without a per-character offset array. */
export function scanText(original: string) {
  const text = original.normalize("NFKC"),
    lower = text.toLowerCase();
  function* tokens() {
    let source = 0,
      folded = 0,
      end = 0;
    const advance = (target: number) => {
      while (folded <= target && source < text.length) {
        const point = text.codePointAt(source)!,
          width = point > 0xffff ? 2 : 1;
        end = source + width;
        const n = text.slice(source, end).toLowerCase().length;
        if (folded + n > target) return source;
        source = end;
        folded += n;
      }
      return source;
    };
    let position = 0;
    for (const match of lower.matchAll(/[\p{L}\p{N}]+/gu)) {
      const start = advance(match.index),
        finish = (advance(match.index + match[0].length - 1), end);
      yield { word: match[0], position: position++, start, end: finish };
    }
  }
  return { text, tokens };
}
