import { PREFIX_WORDS, prefix } from "./format.js";
/** Front-coded fixed prefixes serve boundary searches; full suffix offsets
 * remain available for phrases longer than the stored prefix. */
export function encodeSuffixKeys(tokens: Uint32Array, offsets: Uint32Array) {
  const out: number[] = [];
  let previous = new Uint32Array(PREFIX_WORDS);
  const integer = (n: number) => {
    do {
      const b = n & 127;
      n >>>= 7;
      out.push(b | (n ? 128 : 0));
    } while (n);
  };
  for (const offset of offsets) {
    const words = prefix(tokens, offset);
    let shared = 0;
    while (shared < PREFIX_WORDS && previous[shared] === words[shared])
      shared++;
    out.push(shared);
    for (let i = shared; i < PREFIX_WORDS; i++) integer(words[i]);
    previous = words;
  }
  return Uint8Array.from(out);
}
export function decodeSuffixKeys(bytes: Uint8Array, count: number) {
  const out = new Uint32Array(count * PREFIX_WORDS);
  let at = 0;
  for (let row = 0; row < count; row++) {
    const shared = bytes[at++];
    if (shared > PREFIX_WORDS || (!row && shared))
      throw Error("Invalid suffix prefix");
    if (row)
      out.copyWithin(
        row * PREFIX_WORDS,
        (row - 1) * PREFIX_WORDS,
        (row - 1) * PREFIX_WORDS + shared,
      );
    for (let i = shared; i < PREFIX_WORDS; i++) {
      let n = 0,
        scale = 1,
        done = false;
      for (let j = 0; j < 5 && at < bytes.length; j++) {
        const b = bytes[at++];
        n += (b & 127) * scale;
        if (!(b & 128)) {
          done = true;
          break;
        }
        scale *= 128;
      }
      if (!done || n > 0xffffffff) throw Error("Invalid suffix token");
      out[row * PREFIX_WORDS + i] = n;
    }
  }
  if (at !== bytes.length) throw Error("Trailing suffix prefix data");
  return out;
}
export function comparePhrase(
  key: ArrayLike<number>,
  phrase: ArrayLike<number>,
) {
  for (let i = 0; i < phrase.length; i++) {
    if (!key[i]) return -1;
    if (key[i] !== phrase[i]) return key[i] - phrase[i];
  }
  return 0;
}
