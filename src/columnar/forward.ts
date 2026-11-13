import {
  type Ref,
  type Branch,
  type Scores,
  refAt,
  view,
  unpack,
  lower,
} from "./format.js";
import { Reader } from "./storage.js";
export interface PairBatch {
  docs: Uint32Array;
  body: Uint32Array;
  title: Uint32Array;
  branches: Branch[];
  handles: Uint32Array;
}
/** Verify exact body token IDs around positional pair anchors. A title pair
 * remains unknown and falls back to the normal field-aware positional scanner.
 * No JSON/text frame is loaded or tokenized by this path. */
export async function verifyForward(
  reader: Reader,
  pairReader: Reader,
  pair: PairBatch,
  docs: Uint32Array,
  ids: number[],
  pairOffset: number,
) {
  const first = new Int32Array(docs.length).fill(-1),
    refs = new Map<string, Ref>();
  for (const doc of docs) {
    const r = lower(pair.docs, doc);
    if (pair.docs[r] !== doc) continue;
    const b = pair.branches[pair.handles[r] >>> 8];
    refs.set(pairReader.key(b.positions), b.positions);
    refs.set(pairReader.key(b.locators), b.locators);
  }
  const raw = await pairReader.many([...refs.values()]),
    data = new Map<string, Uint8Array>();
  let at = 0;
  for (const key of refs.keys()) data.set(key, raw[at++]);
  const directories: Ref[] = [],
    starts: Uint32Array[] = [];
  for (let i = 0; i < docs.length; i++) {
    const r = lower(pair.docs, docs[i]);
    if (pair.docs[r] !== docs[i]) {
      directories.push([0, 0, 0]);
      starts.push(new Uint32Array(0));
      continue;
    }
    if (pair.title[r]) first[i] = -2;
    const b = pair.branches[pair.handles[r] >>> 8],
      row = pair.handles[r] & 255,
      p = view(data.get(pairReader.key(b.positions))!),
      n = p.getUint32(0, true),
      base = 4 + (n + 1) * 4,
      from = base + p.getUint32(4 + row * 4, true),
      bl = p.getUint32(from, true);
    const positions = unpack(
      new Uint8Array(p.buffer, p.byteOffset + from + 4, bl),
    );
    pairReader.stats.positionIntegers += positions.length;
    starts.push(positions);
    const l = view(data.get(pairReader.key(b.locators))!);
    directories.push(refAt(l, row * 36 + 12));
  }
  const dirs = await reader.many(directories.filter((r) => r[2] > 0)),
    tokens = new Map<string, Ref>();
  let di = 0;
  const windows: { ref: Ref; first: number }[][] = [];
  for (let i = 0; i < docs.length; i++) {
    const spans: { ref: Ref; first: number }[] = [];
    windows.push(spans);
    if (!directories[i][2]) continue;
    const dir = view(dirs[di++]);
    const frames = new Set<number>();
    for (const p of starts[i]) {
      const s = p - pairOffset;
      if (s < 0) continue;
      frames.add(Math.floor(s / 256));
      frames.add(Math.floor((s + ids.length - 1) / 256));
    }
    for (const frame of frames) {
      const at = frame * 32;
      if (at + 32 > dir.byteLength) continue;
      const ref = refAt(dir, at + 8);
      tokens.set(reader.key(ref), ref);
      spans.push({ ref, first: dir.getUint32(at, true) });
    }
  }
  const tokenData = await reader.many([...tokens.values()]),
    decoded = new Map<string, Uint32Array>();
  at = 0;
  for (const [key, ref] of tokens) {
    const a = reader.decoded(ref, tokenData[at++], unpack, ref[2] * 2);
    reader.stats.positionIntegers += a.length;
    decoded.set(key, a);
  }
  for (let i = 0; i < docs.length; i++)
    for (const p of starts[i]) {
      const start = p - pairOffset;
      if (start < 0) continue;
      let ok = true;
      for (let j = 0; j < ids.length; j++) {
        const position = start + j;
        let value: number | undefined;
        for (const w of windows[i]) {
          const a = decoded.get(reader.key(w.ref))!;
          if (position >= w.first && position < w.first + a.length) {
            value = a[position - w.first];
            break;
          }
        }
        if (value !== ids[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        first[i] = start;
        break;
      }
    }
  return first;
}
