import { concat, view } from "./format.js";
import { scanText } from "./construction/text.js";

const MAGIC = 0x31545843;
/** A soft limit: never split a token or a Unicode code point. */
export const TEXT_CHUNK_CHARACTERS = 16384;
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const malformed =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function textBytes(text: string) {
  // UTF-8 for ordinary text; losslessly preserve lone surrogates accepted by
  // the corpus/tokenizer rather than silently substituting replacement chars.
  if (!malformed.test(text))
    return { bytes: encoder.encode(text), wide: false };
  const bytes = new Uint8Array(text.length * 2),
    v = view(bytes);
  for (let i = 0; i < text.length; i++)
    v.setUint16(i * 2, text.charCodeAt(i), true);
  return { bytes, wide: true };
}
export async function encodeTextChunks(
  text: string,
  starts: number[],
  compress?: (raw: Uint8Array) => Uint8Array,
) {
  const cuts = [{ at: 0, token: 0 }];
  for (let i = 1; i < starts.length; i++)
    if (starts[i] - cuts.at(-1)!.at >= TEXT_CHUNK_CHARACTERS)
      cuts.push({ at: starts[i], token: i });
  const directory = new Uint8Array(8 + cuts.length * 16),
    v = view(directory),
    frames: Uint8Array[] = [];
  v.setUint32(0, MAGIC, true);
  v.setUint32(4, cuts.length, true);
  let offset = 0;
  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i],
      end = cuts[i + 1]?.at ?? text.length,
      value = text.slice(cut.at, end),
      raw = textBytes(value);
    const frame = compress
      ? compress(raw.bytes)
      : new Uint8Array(
          await new Response(
            new Response(raw.bytes as BodyInit).body!.pipeThrough(
              new CompressionStream("gzip"),
            ),
          ).arrayBuffer(),
        );
    [
      cut.token,
      offset,
      frame.length,
      value.length + (raw.wide ? 0x80000000 : 0),
    ].forEach((n, j) => v.setUint32(8 + i * 16 + j * 4, n, true));
    frames.push(frame);
    offset += frame.length;
  }
  return { directory, data: concat(frames) };
}
export class TextChunks {
  private readonly directory: DataView;
  readonly count: number;
  constructor(
    directory: Uint8Array,
    private readonly data: Uint8Array,
    private readonly inflated?: (chunk: number, bytes: number) => void,
  ) {
    this.directory = view(directory);
    if (directory.length < 24 || this.directory.getUint32(0, true) !== MAGIC)
      throw Error("Invalid text directory");
    this.count = this.directory.getUint32(4, true);
    if (!this.count || directory.length !== 8 + this.count * 16)
      throw Error("Invalid text chunk count");
    let next = 0,
      previous = -1;
    for (let i = 0; i < this.count; i++) {
      const p = 8 + i * 16,
        first = this.directory.getUint32(p, true),
        at = this.directory.getUint32(p + 4, true),
        n = this.directory.getUint32(p + 8, true);
      if (
        first <= previous ||
        (!i && first !== 0) ||
        at !== next ||
        !n ||
        at + n > data.length
      )
        throw Error("Invalid text chunk address");
      previous = first;
      next = at + n;
    }
    if (next !== data.length) throw Error("Trailing text chunk bytes");
  }
  private async text(i: number) {
    const p = 8 + i * 16,
      at = this.directory.getUint32(p + 4, true),
      n = this.directory.getUint32(p + 8, true),
      shape = this.directory.getUint32(p + 12, true),
      characters = shape & 0x7fffffff;
    const raw = new Uint8Array(
      await new Response(
        new Response(
          this.data.subarray(at, at + n) as BodyInit,
        ).body!.pipeThrough(new DecompressionStream("gzip")),
      ).arrayBuffer(),
    );
    this.inflated?.(i, raw.length);
    let text: string;
    if (shape & 0x80000000) {
      if (raw.length !== characters * 2)
        throw Error("Invalid UTF-16 text chunk");
      const v = view(raw),
        parts: string[] = [];
      for (let start = 0; start < characters; start += 4096) {
        const codes = new Uint16Array(Math.min(4096, characters - start));
        for (let j = 0; j < codes.length; j++)
          codes[j] = v.getUint16((start + j) * 2, true);
        parts.push(String.fromCharCode(...codes));
      }
      text = parts.join("");
    } else text = decoder.decode(raw);
    if (text.length !== characters) throw Error("Text chunk length mismatch");
    return text;
  }
  async snippet(first?: number) {
    let i = 0;
    if (first !== undefined) {
      let lo = 0,
        hi = this.count;
      while (lo + 1 < hi) {
        const m = (lo + hi) >>> 1;
        if (this.directory.getUint32(8 + m * 16, true) <= first) lo = m;
        else hi = m;
      }
      i = lo;
    }
    const selected = i;
    let lastLoaded = i;
    let text = await this.text(i),
      start = 0,
      end = 400;
    if (first !== undefined) {
      const local = first - this.directory.getUint32(8 + i * 16, true);
      let position = 0,
        found = false;
      for (const token of scanText(text).tokens()) {
        if (position++ === local) {
          start = token.start - 160;
          end = token.end + 240;
          found = true;
          break;
        }
      }
      if (!found) throw Error("Match exceeds text checkpoint");
    }
    if (start < 0 && i > 0) {
      const previous = await this.text(i - 1);
      text = previous + text;
      start += previous.length;
      end += previous.length;
      i--;
    }
    if (end > text.length && selected + 1 < this.count) {
      text += await this.text(selected + 1);
      lastLoaded++;
    }
    const from = Math.max(0, start);
    return (
      (i || from ? "…" : "") +
      text.slice(from, end).trim() +
      (end < text.length || lastLoaded + 1 < this.count ? "…" : "")
    );
  }
}
