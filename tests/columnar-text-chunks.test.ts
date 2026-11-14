import { expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { encodeTextChunks, TextChunks } from "../src/columnar/text-chunks.js";
import { scanText } from "../src/columnar/construction/text.js";

it("stores normalized text exactly once and renders across both sides of chunk checkpoints", async () => {
  const original =
      "\ufeff[A] İ Ａlpha 𐐀 punctuation! \ud800 " +
      "boundary words—".repeat(3600) +
      " END\udfff.",
    scan = scanText(original),
    tokens = [...scan.tokens()],
    encoded = await encodeTextChunks(
      scan.text,
      tokens.map((t) => t.start),
    ),
    directory = new DataView(encoded.directory.buffer),
    count = directory.getUint32(4, true);
  expect(count).toBeGreaterThan(2);
  const decoded: string[] = [],
    first: number[] = [];
  for (let i = 0; i < count; i++) {
    const p = 8 + i * 16,
      at = directory.getUint32(p + 4, true),
      bytes = directory.getUint32(p + 8, true),
      wide = directory.getUint32(p + 12, true) & 0x80000000;
    const raw = gunzipSync(encoded.data.subarray(at, at + bytes));
    decoded.push(raw.toString(wide ? "utf16le" : "utf8"));
    first.push(directory.getUint32(p, true));
  }
  expect(decoded.join("")).toBe(scan.text);
  for (let i = 0; i < count; i++)
    expect([...scanText(decoded[i]).tokens()].map((t) => t.word)).toEqual(
      tokens.slice(first[i], first[i + 1]).map((t) => t.word),
    );
  const positions = new Set([
    0,
    tokens.length - 1,
    ...first.flatMap((p) => [p - 1, p, p + 1]).filter((p) => p >= 0),
  ]);
  for (const position of positions) {
    const observed: number[] = [],
      chunks = new TextChunks(encoded.directory, encoded.data, (i) =>
        observed.push(i),
      ),
      token = tokens[position],
      start = Math.max(0, token.start - 160),
      end = token.end + 240,
      expected =
        (start ? "…" : "") +
        scan.text.slice(start, end).trim() +
        (end < scan.text.length ? "…" : "");
    expect(await chunks.snippet(position)).toBe(expected);
    expect(observed.length).toBeLessThanOrEqual(3);
  }
});
it("preserves empty text, punctuation, long tokens, and reports invalid checkpoints", async () => {
  for (const original of [
    "",
    "!? \ufeff",
    "LongToken".repeat(6000) + " next",
  ]) {
    const scan = scanText(original),
      tokens = [...scan.tokens()],
      encoded = await encodeTextChunks(
        scan.text,
        tokens.map((t) => t.start),
      );
    expect(
      await new TextChunks(encoded.directory, encoded.data).snippet(),
    ).toBe(
      scan.text.slice(0, 400).trim() + (scan.text.length > 400 ? "…" : ""),
    );
    if (tokens.length)
      expect(
        await new TextChunks(encoded.directory, encoded.data).snippet(
          tokens.length - 1,
        ),
      ).toContain("next" === tokens.at(-1)!.word ? "next" : "LongToken");
    const bad = encoded.directory.slice();
    new DataView(bad.buffer).setUint32(12, 1, true);
    expect(() => new TextChunks(bad, encoded.data)).toThrow("address");
    await expect(
      new TextChunks(encoded.directory, encoded.data).snippet(
        tokens.length + 1,
      ),
    ).rejects.toThrow("checkpoint");
  }
});
