import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { OfflineObjects } from "../src/columnar/offline.js";
import { Reader } from "../src/columnar/storage.js";
import { encodeDocumentPackage } from "../src/columnar/document-package.js";
import { concat } from "../src/columnar/format.js";
it("local diagnostics validate grouped package identity and return complete metadata/snippets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cws-offline-")),
    ids = new Map([
      ["alpha", 1],
      ["école", 2],
    ]),
    first = await encodeDocumentPackage(
      { doc: 37, id: "first", body: "alpha" },
      ids,
    ),
    second = await encodeDocumentPackage(
      {
        doc: 38,
        id: "second",
        body: "école alpha",
        title: "École",
        metadata: { n: 38 },
      },
      ids,
    ),
    group = concat([first, second]),
    sha = createHash("sha256").update(group).digest("hex"),
    key = sha + "/plan-0.bin",
    root = { generation: "a".repeat(64), objects: [] },
    objects = new OfflineObjects(dir, root),
    locator = { key, offset: first.length, length: second.length, first: 37 };
  try {
    await mkdir(dir + "/packages/" + sha, { recursive: true });
    await writeFile(dir + "/packages/" + key, group);
    const reader = new Reader(root, objects.source),
      pkg = await reader.document("b".repeat(64), 38, locator);
    expect(await pkg.display()).toEqual({
      id: "second",
      title: "École",
      metadata: { n: 38 },
    });
    expect(await pkg.snippet(new Set([2]))).toContain("école");
    await expect(
      objects.source.readWhole(key, { ...locator, doc: 37 }),
    ).rejects.toThrow("identity");
    await expect(
      objects.source.readWhole(key, { ...locator, doc: 38, first: 38 }),
    ).rejects.toThrow("group identity");
    await objects.close();
    const corrupt = group.slice();
    corrupt[corrupt.length - 1] ^= 1;
    await writeFile(dir + "/packages/" + key, corrupt);
    await expect(
      objects.source.readWhole(key, { ...locator, doc: 38 }),
    ).rejects.toThrow("checksum");
  } finally {
    await objects.close();
    await rm(dir, { recursive: true, force: true });
  }
});
