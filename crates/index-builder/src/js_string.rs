//! JavaScript JSON strings may contain unpaired UTF-16 surrogates. They are
//! non-word boundaries, but display JSON and identifiers must retain their bits.
use serde::{Deserialize, Serialize, Serializer};
use serde_json::value::RawValue;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug)]
pub struct JsString {
    pub text: String,
    raw: Box<RawValue>,
    // Byte offsets in text, each replacing one unpaired code unit with U+FFFD.
    lones: Vec<(usize, u16)>,
}
impl<'de> Deserialize<'de> for JsString {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(d)?;
        Self::parse(raw).map_err(serde::de::Error::custom)
    }
}
impl Serialize for JsString {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.raw.serialize(s)
    }
}
impl JsString {
    fn parse(raw: Box<RawValue>) -> Result<Self, String> {
        let json = raw.get();
        if !json.starts_with('"') {
            return Err("expected string".into());
        }
        if let Ok(text) = serde_json::from_str::<String>(json) {
            return Ok(Self {
                text,
                raw,
                lones: Vec::new(),
            });
        }
        let mut units = Vec::new();
        let mut chars = json[1..json.len() - 1].chars();
        while let Some(c) = chars.next() {
            if c != '\\' {
                units.extend(c.encode_utf16(&mut [0; 2]).iter().copied());
                continue;
            }
            let c = chars.next().ok_or("truncated escape")?;
            let unit = match c {
                'u' => {
                    let mut n = 0;
                    for _ in 0..4 {
                        n = n * 16
                            + chars
                                .next()
                                .and_then(|c| c.to_digit(16))
                                .ok_or("bad Unicode escape")? as u16;
                    }
                    n
                }
                '"' => 34,
                '\\' => 92,
                '/' => 47,
                'b' => 8,
                'f' => 12,
                'n' => 10,
                'r' => 13,
                't' => 9,
                _ => return Err("invalid escape".into()),
            };
            units.push(unit);
        }
        let mut text = String::new();
        let mut lones = Vec::new();
        for c in char::decode_utf16(units) {
            match c {
                Ok(c) => text.push(c),
                Err(e) => {
                    lones.push((text.len(), e.unpaired_surrogate()));
                    text.push('\u{fffd}');
                }
            }
        }
        Ok(Self { text, raw, lones })
    }
    pub fn normalized(mut self) -> Self {
        if self.lones.is_empty() {
            return self;
        }
        let mut text = String::new();
        let mut start = 0;
        for lone in &mut self.lones {
            text.extend(self.text[start..lone.0].nfkc());
            start = lone.0 + 3;
            lone.0 = text.len();
            text.push('\u{fffd}');
        }
        text.extend(self.text[start..].nfkc());
        self.text = text;
        self
    }
    pub fn id_key(&self) -> String {
        // Fixed-width UTF-16 hex is injective and preserves JS lexical order.
        use std::fmt::Write;
        let mut result = String::new();
        for u in self.units(0, self.text.len()) {
            write!(&mut result, "{u:04x}").unwrap();
        }
        result
    }
    fn units(&self, from: usize, end: usize) -> Vec<u16> {
        let mut units = Vec::new();
        let mut lones = self
            .lones
            .iter()
            .filter(|l| l.0 >= from && l.0 < end)
            .peekable();
        for (at, c) in self.text[from..end].char_indices() {
            if lones.peek().is_some_and(|l| l.0 == from + at) {
                units.push(lones.next().unwrap().1);
            } else {
                units.extend(c.encode_utf16(&mut [0; 2]).iter().copied());
            }
        }
        units
    }
    pub fn slice<'a>(
        &'a self,
        text: &'a str,
        from: usize,
        end: usize,
        max_units: usize,
    ) -> Slice<'a> {
        Slice {
            source: self,
            text,
            from,
            end,
            max_units,
        }
    }
}
pub struct Slice<'a> {
    source: &'a JsString,
    text: &'a str,
    from: usize,
    end: usize,
    max_units: usize,
}
impl Serialize for Slice<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        if self.source.lones.is_empty() && self.max_units == usize::MAX {
            return serializer.serialize_str(&self.text[self.from..self.end]);
        }
        let units = if self.source.lones.is_empty() {
            self.text[self.from..self.end].encode_utf16().collect()
        } else {
            self.source.units(self.from, self.end)
        };
        use std::fmt::Write;
        let mut json = String::from("\"");
        for u in units.into_iter().take(self.max_units) {
            match u {
                32..=33 | 35..=91 | 93..=126 => json.push(char::from_u32(u as u32).unwrap()),
                _ => {
                    write!(&mut json, "\\u{u:04x}").unwrap();
                }
            }
        }
        json.push('"');
        RawValue::from_string(json)
            .map_err(serde::ser::Error::custom)?
            .serialize(serializer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_unpaired_units_and_normalized_offsets() {
        let s: JsString = serde_json::from_str(r#""Ａ\ud800😀\udfff z""#).unwrap();
        let s = s.normalized();
        assert_eq!(s.text, "A�😀� z");
        assert_eq!(
            serde_json::to_string(&s.slice(&s.text, 0, s.text.len(), usize::MAX)).unwrap(),
            r#""A\ud800\ud83d\ude00\udfff z""#
        );
        assert_eq!(
            serde_json::to_string(&s.slice(&s.text, 0, s.text.len(), 3)).unwrap(),
            r#""A\ud800\ud83d""#
        );
    }
}
