import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildColumnar } from "../src/columnar/build.js";
import { ColumnarIndex } from "../src/columnar/search.js";
import { Reader } from "../src/columnar/storage.js";
import { OfflineObjects } from "../src/columnar/offline.js";
it("routes a large vocabulary through bounded bundled fences and reads only the needed dictionary branch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cws-routing-"));
  let objects: OfflineObjects | undefined;
  try {
    const docs = Array.from({ length: 1000 }, (_, doc) => ({
      id: String(doc),
      body: Array.from(
        { length: 70 },
        (_, i) => "word" + (doc * 70 + i).toString(36),
      ).join(" "),
    }));
    await writeFile(
      dir + "/input.jsonl",
      docs.map((d) => JSON.stringify(d)).join("\n"),
    );
    const root = await buildColumnar({
      input: dir + "/input.jsonl",
      out: dir + "/index",
    });
    expect(root.dictionaryHeight).toBe(1);
    expect(root.dictionaries.length).toBeLessThanOrEqual(256);
    const index = new ColumnarIndex(root);
    objects = new OfflineObjects(dir + "/index", root);
    const reader = new Reader(root, {
      read: async (key, offset, length) =>
        objects!.read([Number(key.match(/plan-(\d+)/)![1]), offset, length]),
    });
    const result = await index.search("word" + (69999).toString(36), reader);
    expect(result.results.map((r) => r.id)).toEqual(["999"]);
    expect(reader.stats.requests).toBeLessThan(15);
    expect(result.results[0].snippet).toContain("word" + (69999).toString(36));
  } finally {
    await objects?.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);
