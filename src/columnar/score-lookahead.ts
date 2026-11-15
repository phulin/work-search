import type { Ref } from "./format.js";
export const SCORE_LOOKAHEAD_WINDOWS = 8;
/** Prefetch a bounded prefix, then let execution consume it before scheduling
 * another prefix. An oversized single window gets only a fitting prefix;
 * execution still fetches every required ref through its ordinary path. */
export function scoreLookahead(
  groups: Ref[][],
  limit: number,
  footprint: (refs: Ref[]) => number,
) {
  let refs: Ref[] = [],
    windows = 0,
    bytes = 0;
  for (const group of groups) {
    const next = [...refs, ...group],
      size = footprint(next);
    if (size <= limit) {
      refs = next;
      bytes = size;
      windows++;
      continue;
    }
    if (windows) break;
    let prefix = group;
    while (prefix.length && footprint(prefix) > limit)
      prefix = prefix.slice(0, Math.floor(prefix.length / 2));
    return {
      refs: prefix,
      windows: 1,
      bytes: footprint(prefix),
      partial: true,
    };
  }
  return { refs, windows, bytes, partial: false };
}
