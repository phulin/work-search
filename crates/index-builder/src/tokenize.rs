use unicode_normalization::{IsNormalized, UnicodeNormalization, is_nfkc_quick};
include!(concat!(env!("OUT_DIR"), "/word-ranges.rs"));
fn is_word(c: char) -> bool {
    if c.is_ascii() {
        return c.is_ascii_alphanumeric();
    }
    let n = c as u32;
    let i = WORD_RANGES.partition_point(|r| r.1 < n);
    i < WORD_RANGES.len() && WORD_RANGES[i].0 <= n
}
#[derive(Debug)]
pub struct Tokens {
    pub text: String,
    pub lower: String,
    pub spans: Vec<Span>,
}
#[derive(Clone, Copy, Debug)]
pub struct Span {
    pub lower_start: usize,
    pub lower_end: usize,
    pub byte_start: usize,
    pub byte_end: usize,
    pub start: u32,
    pub end: u32,
}
impl Tokens {
    pub fn new(original: &str) -> Self {
        let text: String =
            if original.is_ascii() || is_nfkc_quick(original.chars()) == IsNormalized::Yes {
                original.to_owned()
            } else {
                original.nfkc().collect()
            };
        let lower = text.to_lowercase();
        let mut spans = Vec::new();
        let mut first = None;
        for (at, c) in lower.char_indices() {
            if is_word(c) {
                first.get_or_insert(at);
            } else if let Some(start) = first.take() {
                spans.push(Span {
                    lower_start: start,
                    lower_end: at,
                    byte_start: 0,
                    byte_end: 0,
                    start: 0,
                    end: 0,
                });
            }
        }
        if let Some(start) = first {
            spans.push(Span {
                lower_start: start,
                lower_end: lower.len(),
                byte_start: 0,
                byte_end: 0,
                start: 0,
                end: 0,
            });
        }
        if original.is_ascii() {
            for s in &mut spans {
                s.byte_start = s.lower_start;
                s.byte_end = s.lower_end;
                s.start = s.lower_start as u32;
                s.end = s.lower_end as u32;
            }
            return Self { text, lower, spans };
        }
        // Advance only token boundaries. No per-character offset arrays, including
        // for very long opinions. Lowercase expansions map to the full source char.
        let mut lower_at = 0;
        let mut utf16_at = 0u32;
        let mut i = 0;
        for (at, c) in text.char_indices() {
            let end = at + c.len_utf8();
            let next = lower_at
                + if c.is_ascii() {
                    1
                } else {
                    c.to_lowercase().map(char::len_utf8).sum::<usize>()
                };
            let utf16_end = utf16_at + c.len_utf16() as u32;
            while i < spans.len() && spans[i].lower_start < next {
                if spans[i].lower_start >= lower_at {
                    spans[i].byte_start = at;
                    spans[i].start = utf16_at;
                }
                if spans[i].lower_end <= next {
                    spans[i].byte_end = end;
                    spans[i].end = utf16_end;
                    i += 1;
                } else {
                    break;
                }
            }
            lower_at = next;
            utf16_at = utf16_end;
        }
        assert_eq!(i, spans.len(), "lowercase offset coverage");
        Self { text, lower, spans }
    }
    pub fn term(&self, i: usize) -> &str {
        let s = &self.spans[i];
        &self.lower[s.lower_start..s.lower_end]
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_and_offsets() {
        let t = Tokens::new("😀 ＨＥＬＬＯ İ ΟΣ café a\u{301} ½");
        let words: Vec<_> = (0..t.spans.len()).map(|i| t.term(i)).collect();
        assert_eq!(words, vec!["hello", "i", "ος", "café", "á", "1", "2"]);
        for s in &t.spans {
            assert!(s.byte_end > s.byte_start);
            assert!(s.end > s.start);
        }
        assert_eq!(t.spans[0].start, 3);
    }
}
