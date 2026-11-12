import { it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packCards } from "../src/content/cards-build.js";
import { ResultCards } from "../src/content/cards.js";
import {
  passageExcerpt,
  passageFrames,
  filterTerm,
} from "../src/content/passages.js";
it("locates late Unicode terms without reading preceding opinion chunks and validates immutable ranges", async () => {
  const out = await mkdtemp(join(tmpdir(), "passages-")),
    generation = "a".repeat(64);
  const text =
    "ordinary jurisdiction words. ".repeat(50000) +
    "Café 𐐀 legal decisiveword ruling. " +
    "end ".repeat(100);
  async function* records() {
    yield { doc: 0, id: "opinion", body: [0, 0, 1, 0], text };
  }
  try {
    await packCards(out, generation, 1, records(), "b".repeat(64));
    let bytes = 0,
      reads = 0,
      corrupt = false;
    const bucket = {
      get: async (key: string, options?: any) => {
        const file = await readFile(out + "/" + key.split("/")[1]);
        const b = options?.range
          ? file.subarray(
              options.range.offset,
              options.range.offset + options.range.length,
            )
          : file;
        reads++;
        bytes += b.length;
        const copy = Uint8Array.from(b);
        if (corrupt) copy[0] ^= 1;
        return {
          customMetadata: { generation: key.split("/")[0] },
          arrayBuffer: async () => copy.buffer,
        };
      },
    } as unknown as R2Bucket;
    const card = (await new ResultCards(bucket).get(generation, 0, "opinion"))!;
    expect(card.passages).toBeDefined();
    reads = 0;
    bytes = 0;
    const address = {
      generation: card.passageGeneration!,
      pointer: card.passages!,
    };
    const snippet = await passageExcerpt(bucket, address, ["decisiveword"]);
    expect(snippet).toContain("decisiveword");
    expect(reads).toBeLessThan(15);
    expect(bytes).toBeLessThan(text.length / 10);
    expect(await passageExcerpt(bucket, address, ["café"])).toContain("Café");
    expect(await passageExcerpt(bucket, address, ["missing"])).toBe(
      text.slice(0, 400).trim() + "…",
    );
    corrupt = true;
    await expect(
      passageExcerpt(new Proxy(bucket, {}), address, ["decisiveword"]),
    ).rejects.toThrow(/checksum/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
it("never filters out normalized tokens at passage boundaries", () => {
  const text =
    "ordinary ".repeat(910) +
    "ＣＡＦÉ e\u0301vidence 𐐀 Закон 法律 " +
    "other ".repeat(3000);
  const frames = [...passageFrames(text)];
  for (const frame of frames) {
    const core = frame.text.slice(
      frame.localStart,
      frame.localStart + frame.coreLength,
    );
    for (const m of core.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu))
      expect(
        filterTerm(frame.filter, m[0].normalize("NFKC").toLowerCase()),
      ).toBe(true);
  }
  expect(
    frames
      .map((f) => f.text.slice(f.localStart, f.localStart + f.coreLength))
      .join(""),
  ).toBe(text);
});

it("indexes every token produced by compatibility normalization", () => {
  const f = [...passageFrames("¼²")][0];
  for (const t of ["1", "42"]) expect(filterTerm(f.filter, t)).toBe(true);
});
