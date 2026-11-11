import { rangeGroups } from "./ranges.js";
import { decodePositionsInto } from "../format/decode-block.js";
import { decodeBlockInto } from "../format/decode-block.js";
import {
  BLOCK_SIZE,
  decodeDirectory,
  directoryLength,
  selectBlocks,
} from "../format/blocks.js";
import {
  attachPositions,
  decodeFrequencies,
  type DecodedPostings,
} from "../format/codec.js";
import type { Entry } from "../format/index.js";
import type { Node } from "./parser.js";
import { parallel } from "../storage/types.js";
export type Read = (
  e: Entry,
  positions: boolean,
  offset: number,
  length: number,
) => Promise<Uint8Array>;
export function requiredTerms(n: Node): Set<string> {
  if (n.kind === "term") return new Set([n.term]);
  if (n.kind === "phrase") return new Set(n.terms);
  if (n.kind === "empty" || n.kind === "all" || n.kind === "not")
    return new Set();
  const a = requiredTerms(n.left),
    b = requiredTerms(n.right);
  if (n.kind === "except") return a;
  return n.kind === "or"
    ? new Set([...a].filter((t) => b.has(t)))
    : new Set([...a, ...b]);
}
function merge(lists: DecodedPostings[], positions: boolean): DecodedPostings {
  const n = lists.reduce((s, l) => s + l.docs.length, 0),
    bytes = new Uint8Array(lists.reduce((s, l) => s + l.bytes.length, 0));
  const result: DecodedPostings = {
    docs: new Uint32Array(n),
    body: new Uint32Array(n),
    title: new Uint32Array(n),
    bytes,
    positionOffsets: positions ? new Uint32Array(n) : undefined,
  };
  let row = 0,
    offset = 0;
  for (const l of lists) {
    result.docs.set(l.docs, row);
    result.body.set(l.body, row);
    result.title.set(l.title, row);
    bytes.set(l.bytes, offset);
    if (positions)
      for (let i = 0; i < l.docs.length; i++)
        result.positionOffsets![row + i] = offset + l.positionOffsets![i];
    offset += l.bytes.length;
    row += l.docs.length;
  }
  return result;
}
export async function loadPosting(
  e: Entry,
  positions: boolean,
  read: Read,
  candidates?: Uint32Array,
  adaptiveRanges = true,
): Promise<DecodedPostings> {
  if (candidates?.length === 0) return merge([], positions);
  if (e.df <= BLOCK_SIZE) {
    const [f, p] = await Promise.all([
      read(e, false, 0, e.length),
      positions ? read(e, true, 0, e.positionLength) : undefined,
    ]);
    const list = decodeFrequencies(f, e.df, e.crc);
    if (p) {
      attachPositions(list, p, e.positionCrc);
      list.positionsComplete = true;
    }
    return list;
  }
  // For dense/full scans, one frequency range includes directory and all blocks.
  const sparse = candidates && candidates.length < e.df / 8;
  const fullPositions =
    !sparse && positions ? read(e, true, 0, e.positionLength) : undefined;
  // Observe both promises together so a failed frequency read cannot leave an
  // unhandled position-read rejection.
  const frequencyPromise = read(
    e,
    false,
    0,
    sparse ? directoryLength(e.df, e.format) : e.length,
  );
  const [frequency, eagerPositions] = await Promise.all([
    frequencyPromise,
    fullPositions,
  ]);
  const blocks = decodeDirectory(
    frequency.subarray(0, directoryLength(e.df, e.format)),
    e.df,
    e.length,
    e.positionLength,
    e.crc,
  );
  if (!sparse) {
    const result: DecodedPostings = {
      docs: new Uint32Array(e.df),
      body: new Uint32Array(e.df),
      title: new Uint32Array(e.df),
      bytes: eagerPositions ?? new Uint8Array(0),
      positionOffsets: positions ? new Uint32Array(e.df) : undefined,
    };
    result.positionsComplete = positions;
    result.blocks = blocks;
    result.blockRows = new Uint32Array(blocks.length);
    let row = 0,
      blockIndex = 0;
    for (const block of blocks) {
      result.blockRows[blockIndex++] = row;
      decodeBlockInto(
        frequency,
        block.offset,
        block,
        result,
        row,
        eagerPositions,
        block.positionOffset,
      );
      row += block.count;
    }
    return result;
  }
  const selected = selectBlocks(blocks, sparse ? candidates : undefined);
  // Broadly distributed candidates erase the advantage of tiny ranges. Use
  // at most four contiguous windows per term. Gap bytes may be transferred,
  // but only selected blocks are decoded.
  let runs: number[][] = [];
  for (const i of selected) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] + 1 === i) last.push(i);
    else runs.push([i]);
  }
  if (runs.length > 4) {
    runs = [];
    const width = Math.ceil(blocks.length / 4);
    for (let start = 0; start < blocks.length; start += width) {
      const inWindow = selected.filter((i) => i >= start && i < start + width);
      if (inWindow.length) {
        runs.push(inWindow);
      }
    }
  }
  // Scattered hits often make four windows almost as large as one. Prefer
  // one request in that case while still decoding only selected blocks.
  if (runs.length > 1) {
    const cost = (run: number[]) => {
      const first = blocks[run[0]],
        last = blocks[run[run.length - 1]];
      return (
        last.offset +
        last.length -
        first.offset +
        (positions
          ? last.positionOffset + last.positionLength - first.positionOffset
          : 0)
      );
    };
    if (runs.reduce((sum, run) => sum + cost(run), 0) >= cost(selected) * 0.75)
      runs = [selected];
  }
  if (adaptiveRanges)
    runs = rangeGroups(
      selected,
      (i) => ({
        start: blocks[i].offset + (positions ? blocks[i].positionOffset : 0),
        end:
          blocks[i].offset +
          blocks[i].length +
          (positions ? blocks[i].positionOffset + blocks[i].positionLength : 0),
      }),
      65536 * (positions ? 2 : 1),
    );
  let count = 0,
    byteCount = 0;
  const offsets = runs.map((run) => {
    const row = count,
      byte = byteCount;
    for (const i of run) count += blocks[i].count;
    const first = blocks[run[0]],
      last = blocks[run[run.length - 1]];
    byteCount +=
      last.positionOffset + last.positionLength - first.positionOffset;
    return { row, byte };
  });
  const result: DecodedPostings = {
    docs: new Uint32Array(count),
    body: new Uint32Array(count),
    title: new Uint32Array(count),
    bytes:
      positions && runs.length > 1
        ? new Uint8Array(byteCount)
        : new Uint8Array(0),
    positionOffsets: positions ? new Uint32Array(count) : undefined,
  };
  const flat = runs.flat();
  result.blocks = flat.map((i) => blocks[i]);
  result.blockRows = new Uint32Array(flat.length);
  let blockRow = 0;
  for (let i = 0; i < flat.length; i++) {
    result.blockRows[i] = blockRow;
    blockRow += blocks[flat[i]].count;
  }
  await parallel(
    runs.map((run, i) => ({ run, ...offsets[i] })),
    4,
    async ({ run, row, byte }) => {
      const first = blocks[run[0]],
        last = blocks[run[run.length - 1]];
      const [f, p] = await Promise.all([
        sparse
          ? read(
              e,
              false,
              first.offset,
              last.offset + last.length - first.offset,
            )
          : frequency.subarray(first.offset, last.offset + last.length),
        positions
          ? (eagerPositions ??
            read(
              e,
              true,
              first.positionOffset,
              last.positionOffset + last.positionLength - first.positionOffset,
            ))
          : undefined,
      ]);
      if (p) {
        if (runs.length === 1) result.bytes = p;
        else result.bytes.set(p, byte);
      }
      for (const i of run) {
        const b = blocks[i];
        decodeBlockInto(
          f,
          b.offset - first.offset,
          b,
          result,
          row,
          p,
          b.positionOffset - first.positionOffset,
          byte,
        );
        row += b.count;
      }
    },
  );
  result.positionsComplete = positions && result.docs.length === e.df;
  return result;
}

// Attach only positional blocks intersecting the already-combined coarse set.
// Frequency arrays/directories are reused, so this stage does not refetch them.
export async function attachCandidatePositions(
  e: Entry,
  list: DecodedPostings,
  read: Read,
  candidates: Uint32Array,
): Promise<DecodedPostings> {
  const result = {
    ...list,
    positionEnds: undefined as Uint32Array | undefined,
    positionsComplete: false,
  };
  if (!candidates.length) {
    result.bytes = new Uint8Array(0);
    result.positionOffsets = new Uint32Array(list.docs.length);
    return result;
  }
  if (e.df <= BLOCK_SIZE) {
    attachPositions(
      result,
      await read(e, true, 0, e.positionLength),
      e.positionCrc,
    );
    result.positionsComplete = true;
    return result;
  }
  const blocks = list.blocks!,
    rows = list.blockRows!;
  const selected = selectBlocks(blocks, candidates),
    runs = rangeGroups(selected, (i) => ({
      start: blocks[i].positionOffset,
      end: blocks[i].positionOffset + blocks[i].positionLength,
    }));
  const payloads = await parallel(runs, 4, (run) => {
    const first = blocks[run[0]],
      last = blocks[run[run.length - 1]];
    return read(
      e,
      true,
      first.positionOffset,
      last.positionOffset + last.positionLength - first.positionOffset,
    );
  });
  result.bytes =
    payloads.length === 1
      ? payloads[0]
      : new Uint8Array(payloads.reduce((s, b) => s + b.length, 0));
  result.positionsComplete = selected.length === blocks.length;
  result.positionOffsets = new Uint32Array(list.docs.length);
  let base = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i],
      bytes = payloads[i],
      first = blocks[run[0]];
    if (payloads.length > 1) result.bytes.set(bytes, base);
    for (const blockIndex of run)
      decodePositionsInto(
        bytes,
        blocks[blockIndex].positionOffset - first.positionOffset,
        blocks[blockIndex],
        result,
        rows[blockIndex],
        base,
      );
    base += bytes.length;
  }
  return result;
}
