import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { OBJECT_GROUP } from "../src/columnar/construction/finish.js";
import type { HotTerms } from "../src/columnar/construction/tiered-terms.js";
import type { Root } from "../src/columnar/format.js";
import { u32 } from "../src/columnar/format.js";
import {
  assembleTermDirectory,
  assembleTieredDirectory,
  decodeDirectoryBlock,
  encodeDirectoryBlock,
  type DirectoryBlock,
  type DirectoryTerm,
} from "../src/columnar/term-directory.js";

export async function tieredPacketDirectory(
  state: any,
  original: Root,
  out: string,
  uploader: string,
  token: string,
  call: (path: string, task: string, input: any) => Promise<any>,
  save: (force?: boolean) => Promise<void>,
  width: number,
  capacity = 1000000,
) {
  if (!Number.isInteger(capacity) || capacity < 1)
    throw Error("Invalid hot term capacity");
  await mkdir(out + "/directory-blocks", { recursive: true });
  const load = async (ref: any): Promise<Uint8Array> => {
    const path = out + "/directory-blocks/" + ref.sha256 + ".bin",
      valid = (data: Uint8Array) =>
        data.length === ref.size &&
        createHash("sha256").update(data).digest("hex") === ref.sha256;
    const cached = await readFile(path).catch(() => undefined);
    if (cached && valid(cached)) return cached;
    for (let retry = 0; ; retry++)
      try {
        const r = await fetch(`${uploader}/${ref.key}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(60000),
        });
        if (!r.ok) throw Error("Term metadata read " + r.status);
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (!valid(bytes)) throw Error("Term metadata identity mismatch");
        await writeFile(path, bytes);
        return bytes;
      } catch (error) {
        if (retry === 5) throw error;
        await new Promise((r) => setTimeout(r, 500 * 2 ** retry));
      }
  };
  const pool = async (
    items: any[],
    f: (item: any, i: number) => Promise<void>,
    limit = width,
  ) => {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
          const i = next++;
          if (i >= items.length) return;
          await f(items[i], i);
        }
      }),
    );
  };
  const terms = state.terms.reduce(
      (n: number, j: any) => n + j.completedTerms,
      0,
    ),
    target = Math.min(capacity, terms);
  if (!state.hotSelection) {
    let selection: HotTerms = { count: target, df: 1, lastId: 0xffffffff };
    if (terms > target) {
      // New packet jobs return this histogram while visiting their postings.
      // Older intermediate jobs can recover it from bounded metadata blocks.
      await pool(
        state.terms,
        async (job) => {
          if (
            job.dfCounts &&
            job.dfCounts.reduce((n: number, p: number[]) => n + p[1], 0) ===
              job.completedTerms
          )
            return;
          const histogram = new Map<number, number>();
          for (const block of job.blocks)
            for (const term of decodeDirectoryBlock(
              gunzipSync(await load(block.ref)),
              original.count,
            ).values())
              histogram.set(term.df, (histogram.get(term.df) ?? 0) + 1);
          job.dfCounts = [...histogram];
          await save();
        },
        8,
      );
      const histogram = new Map<number, number>();
      for (const job of state.terms)
        for (const [df, n] of job.dfCounts)
          histogram.set(df, (histogram.get(df) ?? 0) + n);
      let remaining = target,
        cutoff = 1;
      for (const [df, n] of [...histogram].sort((a, b) => b[0] - a[0])) {
        if (remaining <= n) {
          cutoff = df;
          break;
        }
        remaining -= n;
      }
      let lastId: number | undefined;
      for (const job of state.terms) {
        const n = job.dfCounts.find((p: number[]) => p[0] === cutoff)?.[1] ?? 0;
        if (remaining > n) {
          remaining -= n;
          continue;
        }
        for (const block of job.blocks) {
          for (const t of decodeDirectoryBlock(
            gunzipSync(await load(block.ref)),
            original.count,
          ).values())
            if (t.df === cutoff && --remaining === 0) {
              lastId = t.id;
              break;
            }
          if (lastId !== undefined) break;
        }
        break;
      }
      if (lastId === undefined) throw Error("Hot term tie boundary is missing");
      selection = { count: target, df: cutoff, lastId };
    }
    state.hotSelection = selection;
    await save(true);
    console.log("Bundled term selection", selection);
  }
  if (state.hotSelection.count !== target)
    throw Error("Hot directory capacity changed during construction");
  if (!state.tieredTerms) {
    state.tieredTerms =
      terms <= target
        ? state.terms.flatMap((job: any, source: number) =>
            job.blocks.map((block: any, part: number) => ({
              source,
              part,
              output: { hot: block, cold: [], objects: [] },
            })),
          )
        : state.terms.flatMap((job: any, source: number) =>
            Array.from(
              { length: Math.ceil(job.blocks.length / 8) },
              (_, part) => ({ source, part }),
            ),
          );
    await save(true);
  }
  await pool(state.tieredTerms, async (job, i) => {
    if (job.output) return;
    const source = state.terms[job.source],
      root: Root = {
        ...original,
        hot: {},
        dictionaries: [],
        documents: [],
        objects: source.objects,
        objectIds: source.objects.map(
          (_: any, n: number) => job.source * OBJECT_GROUP + n,
        ),
      };
    job.output = await call("/tiered-terms", `tiered-terms-${i}`, {
      root,
      blocks: source.blocks
        .slice(job.part * 8, (job.part + 1) * 8)
        .map((b: any) => b.ref),
      hot: state.hotSelection,
      objectBase: (state.terms.length + i) * OBJECT_GROUP,
    });
    await save();
    if (i % 64 === 0)
      console.log(
        "Tiered terms",
        state.tieredTerms.filter((j: any) => j.output).length,
        "/",
        state.tieredTerms.length,
      );
  });
  const hotBlocks: DirectoryBlock[] = [],
    coldBlocks: DirectoryBlock[] = [],
    objects: Root["objects"] = [],
    objectIds: number[] = [];
  let pending: [string, DirectoryTerm][] = [],
    hotTerms = 0,
    coldTerms = 0;
  const flush = () => {
    if (!pending.length) return;
    hotBlocks.push({
      first: pending[0][0],
      count: pending.length,
      data: gzipSync(encodeDirectoryBlock(pending)),
    });
    hotTerms += pending.length;
    pending = [];
  };
  for (const [i, job] of state.tieredTerms.entries()) {
    const result = job.output;
    if (result.hot)
      for (const term of decodeDirectoryBlock(
        gunzipSync(await load(result.hot.ref)),
        original.count,
      )) {
        pending.push(term);
        if (pending.length === 1024) flush();
      }
    for (const block of result.cold) {
      coldBlocks.push({
        first: block.first,
        count: block.count,
        data: u32(block.ref),
      });
      coldTerms += block.count;
    }
    result.objects.forEach((o: any, n: number) => {
      objects.push(o);
      objectIds.push((state.terms.length + i) * OBJECT_GROUP + n);
    });
  }
  flush();
  if (hotTerms !== target || hotTerms + coldTerms !== terms)
    throw Error("Tiered vocabulary coverage mismatch");
  const directory = assembleTieredDirectory(
    assembleTermDirectory(hotBlocks),
    assembleTermDirectory(coldBlocks),
  );
  await writeFile(out + "/directory.bin", directory);
  return {
    directory,
    terms,
    hotTerms,
    coldTerms,
    objects,
    objectIds,
    bodyOccurrences: state.terms.reduce(
      (n: number, j: any) => n + j.bodyOccurrences,
      0,
    ),
    titleOccurrences: state.terms.reduce(
      (n: number, j: any) => n + j.titleOccurrences,
      0,
    ),
  };
}
