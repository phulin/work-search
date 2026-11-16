import { expect, it } from "vitest";
import { encodePositions, positionSpan } from "../src/columnar/positions.js";
import { PacketObjects } from "../src/columnar/packet-objects.js";
import { ColumnarR2 } from "../src/columnar/r2.js";
import { Reader } from "../src/columnar/storage.js";
import type { Root } from "../src/columnar/format.js";
import { pack, unpackColumn, view } from "../src/columnar/format.js";

it("decodes every integer width across packed word boundaries and preserves destination guards", () => {
  let seed = 9827;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let width = 0; width <= 32; width++)
    for (const count of [0, 1, 2, 31, 32, 33, 127, 128, 129])
      for (const delta of [false, true]) {
        const max = width === 32 ? 0xffffffff : 2 ** width - 1,
          values = Uint32Array.from({ length: count }, (_, i) =>
            i === 1 ? max : (random() & max) >>> 0,
          );
        if (delta) values.sort();
        const raw = pack(values, delta),
          wrapped = new Uint8Array(raw.length + 7),
          out = new Uint32Array(count + 4).fill(1234567);
        wrapped.set(raw, 3);
        expect(unpackColumn(view(wrapped), 3, raw.length, out, 2)).toBe(count);
        expect([...out.subarray(2, count + 2)]).toEqual([...values]);
        expect([...out.subarray(0, 2), ...out.subarray(count + 2)]).toEqual([
          1234567, 1234567, 1234567, 1234567,
        ]);
        expect(() =>
          unpackColumn(view(wrapped), 3, raw.length - 1, out, 2),
        ).toThrow();
      }
  const overflow = pack(Uint32Array.of(0xffffffff), true);
  view(overflow).setUint32(4, 0xffffffff, true);
  overflow[8] = 32;
  const invalid = new Uint8Array(16);
  invalid.set(overflow.subarray(0, 12));
  view(invalid).setUint32(12, 1, true);
  expect(() =>
    unpackColumn(view(invalid), 0, invalid.length, new Uint32Array(1)),
  ).toThrow("overflow");
});

it("independently addresses empty, singleton, repeated and full-width positional spans", () => {
  let seed = 79;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (const count of [1, 7, 128]) {
    const rows = Array.from({ length: count }, (_, row) => {
        const field = (n: number) =>
          Array.from({ length: n }, () => random())
            .sort((a, b) => a - b)
            .filter((n, i, a) => !i || n !== a[i - 1]);
        return { body: field(row % 13), title: field(row % 4) };
      }),
      encoded = encodePositions(rows);
    for (let row = count - 1; row >= 0; row--)
      for (const field of [0, 1]) {
        const wanted = field ? rows[row].title : rows[row].body;
        expect([...positionSpan(encoded, row, field, wanted.length)]).toEqual(
          wanted,
        );
      }
    expect(() => positionSpan(encoded, count, 0, 0)).toThrow();
    expect(() =>
      positionSpan(encoded.subarray(0, encoded.length - 1), 0, 0, 0),
    ).toThrow();
  }
  const singleton = encodePositions([{ body: [0xffffffff], title: [] }]);
  expect([...positionSpan(singleton, 0, 0, 1)]).toEqual([0xffffffff]);
  expect(() => positionSpan(singleton, 0, 0, 2)).toThrow();
});
it("packs logical packets with one write and fetches selected ranges with separate cache identities", async () => {
  const objects = new Map<number, Uint8Array>(),
    writer = new PacketObjects(async (id, data) => {
      objects.set(id, data.slice());
    }),
    a = new Uint8Array(30).fill(7),
    b = new Uint8Array(40).fill(13),
    first = await writer.append(a),
    second = await writer.append(b);
  expect(objects.size).toBe(0);
  await writer.flush();
  expect(objects.size).toBe(1);
  expect(first).toEqual({ object: 0, offset: 0 });
  expect(second).toEqual({ object: 0, offset: 30 });
  const generation = "a".repeat(64),
    reads: { key: string; offset: number; length: number }[] = [],
    source = new ColumnarR2({
      async get(key: string, options: any) {
        const raw = objects.get(0)!;
        reads.push({ key, ...options.range });
        return {
          size: raw.length,
          customMetadata: { generation },
          arrayBuffer: async () =>
            raw.slice(
              options.range.offset,
              options.range.offset + options.range.length,
            ).buffer,
        };
      },
    } as any),
    reader = new Reader({ generation, objects: [] } as unknown as Root, source);
  const values = await Promise.all([
    reader.named(generation + "/pairs-0.bin@0", a.length),
    reader.named(generation + "/pairs-0.bin@30", b.length),
    reader.named(generation + "/pairs-0.bin@0", a.length),
  ]);
  expect(values.map((v) => [...v])).toEqual([[...a], [...b], [...a]]);
  expect(reads).toHaveLength(2);
  expect(reads.map((r) => r.key)).toEqual([
    generation + "/pairs-0.bin",
    generation + "/pairs-0.bin",
  ]);
  expect(await reader.named(generation + "/pairs-0.bin@30", b.length)).toEqual(
    b,
  );
  expect(reads).toHaveLength(2);
  await expect(
    source.readNamed(generation + "/pairs-0.bin@-1", 30),
  ).rejects.toThrow();
});
