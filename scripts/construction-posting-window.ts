import type { Run } from "../src/columnar/construction/runs.js";
import type { TermRange } from "../src/columnar/construction/finish.js";
/** Keep only chunk descriptors reachable by this lexical job. Global document
 * statistics and term ordinals remain unchanged; cursors become window-relative. */
export function postingWindow(run: Run, range: TermRange) {
  const first = range.first.chunk,
    end = range.end ? range.end.chunk + 1 : run.chunks.length;
  if (
    !Number.isInteger(first) ||
    first < 0 ||
    first >= run.chunks.length ||
    end < first + 1 ||
    end > run.chunks.length ||
    (range.end &&
      (range.end.chunk < first ||
        (range.end.chunk === first && range.end.at <= range.first.at)))
  )
    throw Error("Invalid posting window");
  return {
    run: { ...run, chunks: run.chunks.slice(first, end) },
    range: {
      ...range,
      first: { ...range.first, chunk: 0 },
      ...(range.end
        ? { end: { ...range.end, chunk: range.end.chunk - first } }
        : {}),
    },
  };
}
