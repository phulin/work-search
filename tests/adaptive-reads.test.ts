import { it, expect } from "vitest";
import { BinaryIndex, buildBinary, type Entry } from "../src/format/index.js";
import { encodeDocuments } from "../src/format/documents.js";
import { encodePacked } from "../src/format/packed.js";
import { directoryLength } from "../src/format/blocks.js";
import { crc32 } from "../src/format/codec.js";
import { search } from "../src/query/engine.js";
it("grows remote read-ahead across a large stream without changing scores or accepting corrupt blocks", async () => {
  const n = 100000,
    count = Math.ceil(n / 256),
    header = new Uint8Array(directoryLength(n, 8)),
    v = new DataView(header.buffer),
    chunks: Uint8Array[] = [];
  [0x364b4c42, n, 256, count].forEach((x, i) => v.setUint32(i * 4, x, true));
  let offset = header.length;
  for (let i = 0; i < count; i++) {
    const first = i * 256,
      size = Math.min(256, n - first),
      chunk = encodePacked(
        Array.from({ length: size }, (_, j) => ({
          doc: first + j,
          body: 1000000 + first + j,
          title: 0,
        })),
      ),
      p = 16 + i * 52;
    // Position geometry is present, but this frequency-only test deliberately never requests positions.
    [
      first,
      first + size - 1,
      offset,
      chunk.length,
      crc32(chunk),
      i,
      1,
      0,
      size,
    ].forEach((x, j) => v.setUint32(p + j * 4, x, true));
    v.setFloat64(p + 36, 1, true);
    v.setFloat64(p + 44, 0, true);
    chunks.push(chunk);
    offset += chunk.length;
  }
  const stream = new Uint8Array(offset);
  stream.set(header);
  let at = header.length;
  for (const c of chunks) {
    stream.set(c, at);
    at += c.length;
  }
  expect(stream.length).toBeGreaterThan(262144);
  const entry: Entry = {
    term: "term",
    df: n,
    object: 0,
    offset: 0,
    length: stream.length,
    crc: crc32(header),
    positionObject: 0,
    positionOffset: 0,
    positionLength: count,
    positionCrc: 0,
  };
  const documents = encodeDocuments(
    Array.from({ length: n }, (_, i) => ({
      id: `d${i}`,
      body: 1100000,
      title: 0,
      metaObject: 0,
      metaOffset: 0,
      metaLength: 0,
    })),
  );
  const index = new BinaryIndex(
    buildBinary("a".repeat(64), [entry], documents, n, [], 1100000, 0),
  );
  Object.defineProperty(index, "paged", { value: true });
  const storage = {
    read: async (key: string, o: number, len: number) => {
      expect(key).toContain("/frequencies-");
      return stream.slice(o, o + len);
    },
  };
  const reference = await search(index, storage, "term", {
    executor: "materialized",
    exactTotal: true,
  });
  const fixed = await search(index, storage, "term", {
      pagedReadPolicy: "fixed",
    }),
    adaptive = await search(index, storage, "term", {
      pagedReadPolicy: "adaptive",
    });
  expect(adaptive.results).toEqual(reference.results);
  expect(fixed.results).toEqual(reference.results);
  expect(adaptive.diagnostics.frequencyRequests).toBeLessThan(
    fixed.diagnostics.frequencyRequests,
  );
  await expect(
    search(
      index,
      {
        read: async (key, o, len) => {
          const b = await storage.read(key, o, len);
          if (o === 0 && len > header.length) b[header.length + 20] ^= 1;
          return b;
        },
      },
      "term",
      { pagedReadPolicy: "adaptive" },
    ),
  ).rejects.toThrow("checksum");
}, 30000);
