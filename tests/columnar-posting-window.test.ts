import { expect, it } from "vitest";
import { postingWindow } from "../scripts/construction-posting-window.js";
import {
  BuildStore,
  RunWriter,
  termRecord,
  rowRecord,
  type Run,
} from "../src/columnar/construction/runs.js";
import {
  finishPostings,
  type FinishState,
} from "../src/columnar/construction/finish.js";
it("emits identical searchable objects from bounded lexical descriptors, including continuation and shared boundary chunks", async () => {
  const stored = new Map<string, Uint8Array>(),
    store = new BuildStore({} as R2Bucket);
  store.put = async (bytes, name) => {
    const sha256 = Buffer.from(
        await crypto.subtle.digest("SHA-256", bytes as BufferSource),
      ).toString("hex"),
      key = `${sha256}/${name ?? "stage-" + sha256 + ".bin"}`;
    stored.set(key, bytes.slice());
    return { key, sha256, size: bytes.length };
  };
  store.get = async (ref) => stored.get(ref.key)!.slice();
  const writer = new RunWriter(store, 180),
    starts: { chunk: number; at: number }[] = [];
  for (let i = 0; i < 12; i++) {
    // Flush before recording the cursor so boundaries intentionally share chunks.
    const header = termRecord("term" + String(i).padStart(2, "0"), 2);
    if (writer.bytes && writer.bytes + header.length > writer.target)
      await writer.flush();
    starts.push({ chunk: writer.chunks.length, at: writer.bytes });
    await writer.append(header);
    for (const doc of [i, i + 20])
      await writer.append(rowRecord(doc, 20, 2, [1, 4], [0]));
  }
  await writer.finish();
  const run: Run = {
      chunks: writer.chunks,
      first: 0,
      next: 40,
      count: 40,
      bodyTokens: 800,
      titleTokens: 80,
    },
    range = { first: starts[4], end: starts[8], firstTerm: 5 },
    window = postingWindow(run, range);
  expect(window.run.chunks.length).toBeLessThan(run.chunks.length);
  async function emit(input: Run, range: typeof window.range) {
    let state: FinishState | undefined;
    const objects = [];
    do {
      const result = await finishPostings(
        store,
        input,
        { count: 40, avgBody: 20, avgTitle: 2 },
        objects.length,
        state,
        160,
        range,
      );
      state = result.state;
      objects.push(...result.objects);
    } while (!state.done);
    return {
      objects,
      entries: state.dictionaries,
      ids: state.ids,
      hot: state.hot,
    };
  }
  expect(await emit(window.run, window.range)).toEqual(await emit(run, range));
  expect(() =>
    postingWindow(run, { ...range, first: { chunk: 999, at: 0 } }),
  ).toThrow();
});
