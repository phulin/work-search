import { concat, u32, view, type Ref } from "../../src/columnar/format.js";
import type { DirectoryTerm } from "../../src/columnar/term-directory.js";
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
function integer(out: number[], value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw Error("Invalid integer");
  do {
    const n = value % 128;
    value = Math.floor(value / 128);
    out.push(n | (value ? 128 : 0));
  } while (value);
}
const signed = (out: number[], n: number) =>
  integer(out, n < 0 ? -2 * n - 1 : 2 * n);
function take(raw: Uint8Array, cursor: { at: number }) {
  let n = 0,
    scale = 1;
  for (let i = 0; i < 8; i++) {
    if (cursor.at >= raw.length) throw Error("Truncated integer");
    const b = raw[cursor.at++];
    n += (b & 127) * scale;
    if (!Number.isSafeInteger(n)) throw Error("Integer overflow");
    if (!(b & 128)) return n;
    scale *= 128;
  }
  throw Error("Invalid integer");
}
const takeSigned = (raw: Uint8Array, cursor: { at: number }) => {
  const n = take(raw, cursor);
  return n % 2 ? -(n + 1) / 2 : n / 2;
};
// Format experiment only. Most native leaves have one packet block: its score
// span is implied by the CTF header and handle-column size. Consecutive packet
// addresses predict from the previous span's end rather than repeating offsets.
export function encodeCompactDirectory(entries: [string, DirectoryTerm][]) {
  const parts: Uint8Array[] = [u32([0x33424443, entries.length])],
    refs: Ref[] = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
  let previous = new Uint8Array(),
    lastId = 0;
  for (const [word, term] of entries) {
    const bytes = encoder.encode(word),
      out: number[] = [];
    let prefix = 0;
    while (
      prefix < previous.length &&
      prefix < bytes.length &&
      previous[prefix] === bytes[prefix]
    )
      prefix++;
    const derived =
      !term.tree.height &&
      !term.frequencyParts?.length &&
      !term.positionalParts?.length &&
      term.tree.score[0] === term.frequencies[0] &&
      term.tree.score[1] === term.frequencies[1] + 72 &&
      term.tree.score[2] === term.frequencies[2] - 72 - term.df * 4;
    const flags =
      +(term.df === 1) |
      (+(term.bodyOccurrences === term.df) << 1) |
      (+(term.titleOccurrences === 0) << 2) |
      (+(term.id === lastId + 1) << 3) |
      (+derived << 4) |
      (+!!term.frequencyParts?.length << 5) |
      (+!!term.positionalParts?.length << 6) |
      (+!!term.embedded?.length << 7);
    integer(out, prefix);
    integer(out, bytes.length - prefix);
    integer(out, flags);
    if (!(flags & 8)) signed(out, term.id - lastId);
    if (!(flags & 1)) integer(out, term.df);
    if (!(flags & 2)) integer(out, term.bodyOccurrences);
    if (!(flags & 4)) integer(out, term.titleOccurrences);
    parts.push(Uint8Array.from(out), bytes.subarray(prefix));
    const data: number[] = [];
    const ref = (r: Ref, j: number) => {
      const p = refs[j],
        object = r[0] !== p[0],
        offset = object ? 0 : p[1] + p[2],
        flags = +object | (+(r[1] !== offset) << 1) | (+(r[2] !== p[2]) << 2);
      integer(data, flags);
      if (object) signed(data, r[0] - p[0]);
      if (flags & 2) signed(data, r[1] - offset);
      if (flags & 4) signed(data, r[2] - p[2]);
      refs[j] = r;
    };
    if (!derived) {
      integer(data, term.tree.height);
      if (term.tree.height) {
        integer(data, term.tree.first);
        integer(data, term.tree.last - term.tree.first);
        const bounds = new Uint8Array(16),
          v = view(bounds);
        v.setFloat64(0, term.tree.b, true);
        v.setFloat64(8, term.tree.t, true);
        parts.push(Uint8Array.from(data), bounds);
        data.length = 0;
      }
      ref(term.tree.score, 0);
      ref(term.tree.positions, 1);
    }
    ref(term.frequencies, 2);
    ref(term.positional, 3);
    for (const [list, j] of [
      [term.frequencyParts, 2],
      [term.positionalParts, 3],
    ] as const)
      if (list?.length) {
        integer(data, list.length);
        for (const r of list) ref(r, j);
      }
    if (flags & 128) integer(data, term.embedded!.length);
    parts.push(Uint8Array.from(data));
    if (flags & 128) parts.push(term.embedded!);
    previous = bytes;
    lastId = term.id;
  }
  return concat(parts);
}
export function decodeCompactDirectory(raw: Uint8Array, documents: number) {
  if (raw.length < 8 || view(raw).getUint32(0, true) !== 0x33424443)
    throw Error("Invalid compact directory");
  const count = view(raw).getUint32(4, true),
    cursor = { at: 8 },
    result = new Map<string, DirectoryTerm>(),
    refs: Ref[] = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
  if (!count || count > 4096) throw Error("Invalid compact count");
  let previous = new Uint8Array(),
    lastId = 0,
    lastWord: string | undefined;
  for (let i = 0; i < count; i++) {
    const prefix = take(raw, cursor),
      suffix = take(raw, cursor),
      flags = take(raw, cursor),
      id = lastId + (flags & 8 ? 1 : takeSigned(raw, cursor)),
      df = flags & 1 ? 1 : take(raw, cursor),
      bodyOccurrences = flags & 2 ? df : take(raw, cursor),
      titleOccurrences = flags & 4 ? 0 : take(raw, cursor);
    if (
      flags > 255 ||
      prefix > previous.length ||
      cursor.at + suffix > raw.length ||
      !df ||
      df > documents ||
      id < 0 ||
      id > 0xffffffff
    )
      throw Error("Invalid compact term");
    const bytes = new Uint8Array(prefix + suffix);
    bytes.set(previous.subarray(0, prefix));
    bytes.set(raw.subarray(cursor.at, cursor.at + suffix), prefix);
    cursor.at += suffix;
    const name = decoder.decode(bytes),
      ref = (j: number): Ref => {
        const flags = take(raw, cursor),
          old = refs[j];
        if (flags > 7) throw Error("Invalid compact reference");
        const object = old[0] + (flags & 1 ? takeSigned(raw, cursor) : 0),
          offset =
            (flags & 1 ? 0 : old[1] + old[2]) +
            (flags & 2 ? takeSigned(raw, cursor) : 0),
          length = old[2] + (flags & 4 ? takeSigned(raw, cursor) : 0),
          value: Ref = [object, offset, length];
        if (value.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffffffff))
          throw Error("Invalid compact address");
        refs[j] = value;
        return value;
      };
    let height = 0,
      first = 0,
      last = documents - 1,
      b =
        Math.log(1 + (documents - df + 0.5) / (df + 0.5)) *
        2.2 *
        (1 + Number.EPSILON * 64),
      t = b,
      score: Ref | undefined,
      positions: Ref | undefined;
    if (!(flags & 16)) {
      height = take(raw, cursor);
      if (height) {
        first = take(raw, cursor);
        last = first + take(raw, cursor);
        if (cursor.at + 16 > raw.length)
          throw Error("Truncated compact bounds");
        b = view(raw).getFloat64(cursor.at, true);
        t = view(raw).getFloat64(cursor.at + 8, true);
        cursor.at += 16;
      }
      score = ref(0);
      positions = ref(1);
    }
    const frequencies = ref(2),
      positional = ref(3),
      parts = (j: number) => {
        const n = take(raw, cursor);
        if (n > 4096) throw Error("Invalid compact parts");
        return Array.from({ length: n }, () => ref(j));
      },
      frequencyParts = flags & 32 ? parts(2) : undefined,
      positionalParts = flags & 64 ? parts(3) : undefined,
      embeddedLength = flags & 128 ? take(raw, cursor) : 0;
    if (
      cursor.at + embeddedLength > raw.length ||
      (lastWord !== undefined && name <= lastWord) ||
      (flags & 16 &&
        (frequencies[2] <= 72 + df * 4 || frequencyParts || positionalParts))
    )
      throw Error("Invalid compact leaf");
    const embedded = embeddedLength
      ? raw.slice(cursor.at, cursor.at + embeddedLength)
      : undefined;
    cursor.at += embeddedLength;
    result.set(name, {
      id,
      df,
      bodyOccurrences,
      titleOccurrences,
      frequencies,
      positional,
      tree: {
        first,
        last,
        count: df,
        height,
        b,
        t,
        score: score ?? [
          frequencies[0],
          frequencies[1] + 72,
          frequencies[2] - 72 - df * 4,
        ],
        positions: positions ?? positional,
        locators: [0, 0, 0],
      },
      ...(frequencyParts ? { frequencyParts } : {}),
      ...(positionalParts ? { positionalParts } : {}),
      embedded,
    });
    previous = bytes;
    lastId = id;
    lastWord = name;
  }
  if (cursor.at !== raw.length) throw Error("Trailing compact directory bytes");
  return result;
}
