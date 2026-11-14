import { it, expect, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  prepareServing,
  loadServingAssets,
  matchesServingHealth,
  servingRoot,
  localServingSource,
  verifyDocumentPublication,
} from "../scripts/columnar-serving.js";
import { assembleTermDirectory } from "../src/columnar/term-directory.js";
import {
  encodeDocumentDirectory,
  pack,
} from "../src/columnar/document-directory.js";
import {
  encodePairRouter,
  NO_PAIR_PARTITION,
} from "../src/columnar/pair-router.js";
import { encodePairMembershipPacket } from "../src/columnar/pair-membership.js";
import { encodeExactPhraseDirectory } from "../src/columnar/exact-phrase-directory.js";
import { buildMetadata } from "../scripts/build-columnar-metadata.js";
import type { Root } from "../src/columnar/format.js";
it("prepares a coherent replacement Worker locally and refuses mixed metadata generations or damaged bundled roots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cws-serving-")),
    fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(Error("No network allowed"));
  try {
    const generation = "a".repeat(64),
      td = assembleTermDirectory([]),
      dd = encodeDocumentDirectory(
        [
          {
            first: 0,
            end: 2,
            sha256: "b".repeat(64),
            offsets: pack([0, 64, 128], true),
          },
        ],
        2,
      ),
      descriptor = (b: Uint8Array) => ({
        bytes: b.length,
        sha256: createHash("sha256").update(b).digest("hex"),
      });
    const root: Root = {
      format: "CWS1",
      generation,
      count: 2,
      avgBody: 1,
      avgTitle: 1,
      corpusHash: "c".repeat(64),
      documents: [],
      dictionaries: [],
      hot: {},
      objects: [
        {
          name: "plan-0.bin",
          size: 16,
          sha256: "d".repeat(64),
          checksums: [123],
        },
      ],
      directory: { ...descriptor(td), terms: 0 },
      documentPackages: {
        generation: "b".repeat(64),
        count: 2,
        averageBytes: 64,
        bytes: 128,
        locators: { ...descriptor(dd), groups: 1 },
      },
    };
    await writeFile(dir + "/root.json", JSON.stringify(root));
    await writeFile(dir + "/directory.bin", td);
    await writeFile(dir + "/documents.bin", dd);
    await mkdir(dir + "/membership");
    const router = encodePairRouter(
      {
        generation: "e".repeat(64),
        baseGeneration: generation,
        documents: 2,
        targetBytes: 131072,
        contextBytes: 8192,
        namespaces: [],
        roots: [NO_PAIR_PARTITION],
        commonWords: [],
      },
      [],
      [],
      encodePairMembershipPacket([]),
    );
    await writeFile(dir + "/membership/router.bin", router);
    await writeFile(
      dir + "/membership/exact-phrases.bin",
      encodeExactPhraseDirectory(
        {
          generation: "f".repeat(64),
          baseGeneration: generation,
          documents: 2,
          objects: [],
        },
        [],
      ),
    );
    await writeFile(
      dir + "/membership/presence.json",
      JSON.stringify({ generation: "e".repeat(64), entries: [] }),
    );
    const m = await buildMetadata(
      root,
      { court: "string" },
      (async function* () {
        yield { doc: 0, metadata: { court: "ca1" } };
        yield { doc: 1, metadata: { court: "scotus" } };
      })(),
      dir + "/metadata",
    );
    const head = async () => ({
      status: 200,
      headers: {
        "content-length": "128",
        "x-sha256": "b".repeat(64),
        "x-package-first": "0",
        "x-package-end": "2",
      },
    });
    await verifyDocumentPublication(dd, head);
    await expect(
      verifyDocumentPublication(dd, async () => ({
        ...(await head()),
        headers: {
          ...(await head().then((h) => h.headers)),
          "x-package-end": "1",
        },
      })),
    ).rejects.toThrow("Unpublished document group");
    const report = await prepareServing(
      dir,
      dir + "/prepared",
      "work-search-cws-filter-test",
    );
    expect(report.documents).toBe(2);
    expect(report.documentGroups).toBe(1);
    expect(report.commonWords).toBe(100);
    expect(report.commonPairs).toBe(1000);
    expect(report.metadataFields).toEqual(["court"]);
    expect(report.auxiliaryObjects).toBe(1);
    expect(report.auxiliaryLocalSizesVerified).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    const entry = await readFile(dir + "/prepared/entry.ts", "utf8");
    expect(entry).toContain("new PairRouter");
    expect(entry).toContain("new ExactPhraseDirectory");
    expect(entry).toContain("metadataManifest as any");
    expect(
      JSON.parse(await readFile(dir + "/prepared/root.json", "utf8"))
        .objects[0],
    ).not.toHaveProperty("checksums");
    expect(root.objects[0].checksums).toEqual([123]);
    expect(servingRoot(root).generation).toBe(root.generation);
    const a = await loadServingAssets(dir);
    const health = {
      format: "CWS1",
      generation: root.generation,
      documents: 2,
      metadataGeneration: m.generation,
      pairGeneration: "e".repeat(64),
      exactPhraseGeneration: "f".repeat(64),
      commonWordAnchorsExcluded: 100,
      commonPairAnchorsExcluded: 1000,
    };
    expect(matchesServingHealth(a, health)).toBe(true);
    expect(
      matchesServingHealth(a, { ...health, exactPhraseGeneration: undefined }),
    ).toBe(false);
    expect(
      matchesServingHealth(a, { ...health, metadataGeneration: undefined }),
    ).toBe(false);
    expect(
      matchesServingHealth(a, { ...health, commonPairAnchorsExcluded: 500 }),
    ).toBe(false);
    class Source {
      value = 17;
      async read() {
        return Uint8Array.of(this.value);
      }
    }
    expect(
      await localServingSource(new Source(), a).read("unused", 0, 1),
    ).toEqual(Uint8Array.of(17));
    const bad = { ...m, baseGeneration: "f".repeat(64) };
    await writeFile(dir + "/metadata/metadata.json", JSON.stringify(bad));
    await expect(loadServingAssets(dir)).rejects.toThrow("generation");
    await writeFile(dir + "/metadata/metadata.json", JSON.stringify(m));
    await writeFile(dir + "/directory.bin", Uint8Array.of(0));
    await expect(loadServingAssets(dir)).rejects.toThrow("identity mismatch");
  } finally {
    fetch.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
