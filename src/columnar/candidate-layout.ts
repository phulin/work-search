import { positionalTerms, type Node } from "../query/parser.js";
import {
  PAGE,
  lower,
  objectAt,
  type Branch,
  type Root,
  type Ref,
} from "./format.js";
import type { DirectoryTerm } from "./term-directory.js";
import type { Reader } from "./storage.js";
export async function leaves(
  reader: Reader,
  branch: Branch,
  lo: number,
  hi: number,
): Promise<Branch[]> {
  if (branch.last < lo || branch.first >= hi) return [];
  if (!branch.height) return [branch];
  const children = await reader.branches(branch.score);
  return (
    await Promise.all(
      children
        .filter((b) => b.last >= lo && b.first < hi)
        .map((b) => leaves(reader, b, lo, hi)),
    )
  ).flat();
}
/** Inspect bounded document windows, retaining page identities rather than a
 * flat posting plan. This is a cost estimate only; no matching/pruning proof. */
export async function candidateLayout(
  ast: Node,
  terms: ReadonlyMap<string, DirectoryTerm>,
  root: Root,
  reader: Reader,
  ids: Uint32Array,
  load: (
    reader: Reader,
    tree: Branch,
    lo: number,
    hi: number,
  ) => Promise<Branch[]> = leaves,
  covered?: (words: string[]) => boolean,
) {
  const pages = new Map<number, Set<number>>(),
    positions = positionalTerms(ast, covered),
    last = new Map<string, string>(),
    bands = new Set<number>();
  let scoreBytes = 0,
    positionBytes = 0,
    postings = 0,
    windows = 0;
  const add = (ref: Ref) => {
    if (!ref[2]) return;
    let ps = pages.get(ref[0]);
    if (!ps) {
      ps = new Set();
      pages.set(ref[0], ps);
    }
    for (
      let p = Math.floor(ref[1] / PAGE);
      p <= Math.floor((ref[1] + ref[2] - 1) / PAGE);
      p++
    )
      ps.add(p);
  };
  const WINDOW = 8 * 16384;
  for (let at = 0; at < ids.length;) {
    const lo = Math.floor(ids[at] / WINDOW) * WINDOW,
      hi = Math.min(root.count, lo + WINDOW),
      end = lower(ids, hi),
      selected = ids.subarray(at, end);
    for (const doc of selected) bands.add(Math.floor(doc / 16384));
    await Promise.all(
      [...terms].map(async ([name, t]) => {
        const blocks = await load(reader, t.tree, lo, hi);
        for (const b of blocks) {
          const row = lower(selected, b.first);
          if (row === selected.length || selected[row] > b.last) continue;
          const key = b.score.join(":");
          if (last.get(name) === key) continue;
          last.set(name, key);
          add(b.score);
          scoreBytes += b.score[2];
          postings += b.count;
          if (positions.has(name)) {
            add(b.positions);
            positionBytes += b.positions[2];
          }
        }
      }),
    );
    windows++;
    at = end;
  }
  let bytes = 0,
    residentBytes = 0,
    gets = 0;
  for (const [object, ps] of pages) {
    const descriptor = objectAt(root, object);
    if (!descriptor) throw Error("Unknown candidate page object");
    for (const p of ps) {
      const n = Math.min(PAGE, descriptor.size - p * PAGE);
      bytes += n;
      gets++;
      if (
        reader.memory.pages.entries.has(
          `${root.generation}/${reader.namespace}/${object}/${p}`,
        )
      )
        residentBytes += n;
    }
  }
  return {
    bytes,
    residentBytes,
    gets,
    scoreBytes,
    positionBytes,
    postings,
    candidateBands: bands.size,
    windows,
  };
}
