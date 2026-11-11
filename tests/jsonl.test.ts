import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonLines } from "../src/builder/jsonl.js";
import { build } from "../src/builder/build.js";
import { BinaryIndex } from "../src/format/index.js";
import { FileStorage } from "../src/storage/filesystem.js";
import { search } from "../src/query/engine.js";
it("keeps literal Unicode line/paragraph separators inside JSON records across chunks and CRLF", async () => {
  const root = await mkdtemp(join(tmpdir(), "jsonl-"));
  try {
    const docs = [
      {
        id: "first\u2029id",
        title: "a\u2028title",
        body: "alpha\u2029beta " + "x".repeat(65530) + " é\u2028gamma",
        metadata: { value: "raw\u2029value" },
      },
      { id: "second", body: "delta\nepsilon" },
      { id: "last", body: "omega" },
    ];
    const input = root + "/input";
    await writeFile(input, docs.map((d) => JSON.stringify(d)).join("\r\n"));
    const rows = [];
    for await (const line of jsonLines(input)) rows.push(JSON.parse(line));
    expect(rows).toEqual(docs);
    await build({ input, out: root + "/index", chunkDocs: 1 });
    const index = new BinaryIndex(await readFile(root + "/index/bundle.bin")),
      storage = new FileStorage(root + "/index/objects");
    expect(index.count).toBe(3);
    expect(
      (await search(index, storage, '"alpha beta"', { metadata: true }))
        .results,
    ).toEqual([
      expect.objectContaining({
        id: docs[0].id,
        title: docs[0].title,
        metadata: docs[0].metadata,
      }),
    ]);
    expect(
      (await search(index, storage, '"delta epsilon"')).results[0].id,
    ).toBe("second");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
