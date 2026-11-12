import { it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "../demo/cursor.js";
import { packOpinions } from "../src/content/pack.js";
import { opinionInfo, opinionText, excerpt } from "../src/content/read.js";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/builder/build.js";
import { openIndex } from "../src/format/paged.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
it("signs generation-pinned pagination cursors and rejects changes and expiration", async () => {
  const value = {
    q: "court",
    expires: Date.now() + 60000,
    generations: { 0: "a".repeat(64) },
    after: { score: 1.23456789012345, shard: 0, doc: 50 },
  };
  const cursor = await encodeCursor(value, "secret");
  expect(await decodeCursor(cursor, "secret")).toEqual(value);
  await expect(decodeCursor(cursor, "wrong")).rejects.toThrow();
  await expect(decodeCursor(cursor + ".extra", "secret")).rejects.toThrow();
  await expect(
    decodeCursor(
      await encodeCursor({ ...value, expires: 1 }, "secret"),
      "secret",
    ),
  ).rejects.toThrow();
});
it("pages beyond 100 hits with score/doc tie breakers without duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "pages-"));
  try {
    const docs = Array.from({ length: 400 }, (_, i) => ({
      id: "d" + i,
      body: "court evidence " + "court ".repeat(i % 11),
    }));
    await writeFile(
      root + "/docs",
      docs.map((d) => JSON.stringify(d)).join("\n"),
    );
    await build({ input: root + "/docs", out: root + "/index" });
    const index = openIndex(await readFile(root + "/index/bundle.bin")),
      storage = new FileStorage(root + "/index/objects");
    const all = [];
    let after: undefined | { score: number; doc: number };
    for (let i = 0; i < 20; i++) {
      const page = await search(index, storage, "court", {
        limit: 20,
        after,
        internalDoc: true,
      });
      expect(page.results).toHaveLength(20);
      for (const hit of page.results as any[]) all.push(hit.id);
      const last: any = page.results.at(-1);
      after = { score: last.score, doc: last.doc };
    }
    expect(new Set(all).size).toBe(400);
    expect((await search(index, storage, "court", { after })).results).toEqual(
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
it("packs full Unicode opinion text and reads viewer metadata and highlighted-excerpt context through ranges", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-"));
  try {
    const docs = [
      {
        id: "opinion:1",
        title: "Café v. Court",
        body:
          "Opening. " +
          "background ".repeat(1000) +
          "Qualified immunity applies here. 判例 😀",
        metadata: { url: "https://www.courtlistener.com/opinion/1/" },
      },
      { id: "opinion:2", title: "Other", body: "Another full opinion." },
    ];
    await writeFile(
      root + "/docs",
      docs.map((d) => JSON.stringify(d)).join("\n"),
    );
    const m = await packOpinions(
      root + "/docs",
      root + "/packed",
      docs.length,
      (i) => docs[i].id,
    );
    expect(m.objects.length).toBe(3);
    const generation = "a".repeat(64);
    const bucket = {
      get: async (key: string, options: any) => {
        const name = key.split("/").at(-1)!;
        const file = await readFile(root + "/packed/" + name),
          b = file.subarray(
            options.range.offset,
            options.range.offset + options.range.length,
          );
        return {
          customMetadata: { generation },
          arrayBuffer: async () =>
            b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
          body: new Response(b).body,
        };
      },
    } as unknown as R2Bucket;
    expect(await opinionInfo(bucket, generation, 0)).toEqual({
      id: docs[0].id,
      title: docs[0].title,
      metadata: docs[0].metadata,
    });
    expect(
      await new Response(await opinionText(bucket, generation, 0)).text(),
    ).toBe(docs[0].body);
    expect(
      await excerpt(bucket, generation, 0, ["qualified", "immunity"]),
    ).toContain("Qualified immunity");
    await expect(contentBad()).rejects.toThrow();
    async function contentBad() {
      return opinionText(bucket, "wrong", 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
