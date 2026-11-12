// Generate precisely the V8 category predicate used by the serving tokenizer.
const ranges = []; let first = -1, last = -1;
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  if (/[\p{L}\p{N}]/u.test(String.fromCodePoint(cp))) {
    if (cp !== last + 1) { if (first >= 0) ranges.push([first, last]); first = cp; } last = cp;
  }
}
if (first >= 0) ranges.push([first, last]);
process.stdout.write(`pub const V8_UNICODE: &str = ${JSON.stringify(process.versions.unicode)};\npub static WORD_RANGES: &[(u32,u32)] = &[${ranges.map(([a,b])=>`(${a},${b})`).join(',')}];\n`);
