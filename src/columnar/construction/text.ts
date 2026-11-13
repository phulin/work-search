import { normalizeTerm, type Analysis } from "../../query/analysis.js";
/** Stemming changes token identity, never display spans or position counts. */
export function scanText(original: string, analysis?: Analysis) {
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
      yield {
        word: normalizeTerm(match[0], analysis),
        position: position++,
        start,
        end: finish,
      };
    }
  }
  return { text, tokens };
}
