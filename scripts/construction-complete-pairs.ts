import { createHash } from "node:crypto";
import type { Catalogue } from "../src/columnar/construction/catalogue.js";
import type { Chunk } from "../src/columnar/construction/runs.js";
import type { CompletePairRun } from "../src/columnar/construction/complete-pairs.js";
import { encodeRangePairRouter } from "../src/columnar/pair-router.js";
import { encodePairMembershipPacket } from "../src/columnar/pair-membership.js";
import { u32 } from "../src/columnar/format.js";

export function pairRangeRun(
  run: CompletePairRun,
  range: { first: number; end: number },
): CompletePairRun {
  const lower = (hash: number) => {
    let lo = 0,
      hi = run.chunks.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (run.chunks[m].firstHash < hash) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  return {
    ...run,
    chunks: run.chunks.slice(
      Math.max(0, lower(range.first) - 1),
      lower(range.end),
    ),
  };
}

export async function buildCompletePairs(
  catalogue: Catalogue,
  catalogueRef: Chunk,
  packages: any[],
  call: (path: string, task: string, body: any) => Promise<any>,
  stage: (task: string, value: any) => Promise<Chunk>,
  pool: <T, R>(
    rows: T[],
    fn: (row: T, index: number) => Promise<R>,
  ) => Promise<R[]>,
  ranges = 64,
) {
  if (
    !Number.isInteger(ranges) ||
    ranges < 1 ||
    ranges > 64 ||
    2 ** Math.floor(Math.log2(ranges)) !== ranges
  )
    throw Error("Invalid pair construction parallelism");
  const generation = createHash("sha256")
      .update(
        JSON.stringify({
          catalogue: catalogueRef.sha256,
          format: "complete-pairs-v1",
        }),
      )
      .digest("hex"),
    commonWords = catalogue.pairTerms.slice(0, 200);
  let runs: CompletePairRun[] = packages.flatMap((p) => p.completePairs),
    level = 0;
  if (
    !runs.length ||
    runs[0].first !== 0 ||
    runs.at(-1)!.end !== catalogue.documents
  )
    throw Error("Incomplete pair construction input");
  const expectedOccurrences = runs.reduce((n, r) => n + r.occurrences, 0);
  async function merge(
    group: CompletePairRun[],
    task: string,
    range?: { first: number; end: number },
  ): Promise<CompletePairRun> {
    if (group.length === 1 && !range) return group[0];
    const runsRef = await stage(task + "-inputs", group),
      chunks: CompletePairRun["chunks"] = [];
    let stateRef: Chunk | undefined,
      done = false,
      step = 0;
    do {
      const r = await call("/merge-complete-pairs", task + "-" + step++, {
        runsRef,
        ...(stateRef ? { stateRef } : {}),
        ...(range ? { range } : {}),
      });
      chunks.push(...r.chunks);
      stateRef = r.stateRef;
      done = r.state.done;
    } while (!done);
    return {
      version: 1,
      catalogue: catalogueRef.sha256,
      first: group[0].first,
      end: group.at(-1)!.end,
      chunks,
      occurrences: group.reduce((n, r) => n + r.occurrences, 0),
    };
  }
  while (runs.length > 256) {
    const groups = Array.from({ length: Math.ceil(runs.length / 16) }, (_, i) =>
      runs.slice(i * 16, i * 16 + 16),
    );
    runs = await pool(groups, (group, i) =>
      merge(group, `complete-merge-${level}-${i}`),
    );
    level++;
  }
  // Independent hash ranges share a complete catalogue and read only overlapping
  // sorted blocks. There is no serial corpus-wide final merge.
  const outputs = (
    await pool(
      Array.from({ length: ranges }, (_, i) => i),
      async (i) => {
        const range = {
          first: i * (2 ** 32 / ranges),
          end: (i + 1) * (2 ** 32 / ranges),
        };
        let selected = runs.map((r) => pairRangeRun(r, range)),
          level = 0;
        while (selected.length > 16) {
          const groups = Array.from(
            { length: Math.ceil(selected.length / 16) },
            (_, g) => selected.slice(g * 16, g * 16 + 16),
          );
          selected = await pool(groups, (group, g) =>
            merge(group, `complete-range-${i}-merge-${level}-${g}`, range),
          );
          level++;
        }
        const run = await merge(selected, `complete-range-${i}`, range),
          runRef = await stage(`complete-range-${i}-run`, run),
          results: any[] = [];
        let stateRef: Chunk | undefined,
          done = false,
          step = 0;
        do {
          const r = await call(
            "/finish-complete-pairs",
            `complete-finish-${i}-${step++}`,
            {
              runRef,
              generation,
              documents: catalogue.documents,
              commonWords,
              ...(stateRef ? { stateRef } : {}),
            },
          );
          results.push(r);
          stateRef = r.stateRef;
          done = r.state.done;
        } while (!done);
        return results;
      },
    )
  ).flat();
  const coverage = outputs.reduce(
    (s, o) => {
      for (const k of [
        "pairs",
        "occurrences",
        "memberships",
        "bodyMemberships",
        "titleMemberships",
      ])
        s[k] += o.coverage[k];
      return s;
    },
    {
      pairs: 0,
      occurrences: 0,
      memberships: 0,
      bodyMemberships: 0,
      titleMemberships: 0,
    },
  );
  if (
    coverage.occurrences !== expectedOccurrences ||
    outputs.some((o) => !o.coverage.completeContext)
  )
    throw Error("Incomplete pair occurrence/context coverage");
  const hot = [
    ...new Map(
      outputs.flatMap((o) => o.hot).map((p) => [p.a + "\0" + p.b, p]),
    ).values(),
  ].sort(
    (a: any, b: any) =>
      b.df - a.df || (a.a < b.a ? -1 : a.a > b.a ? 1 : a.b < b.b ? -1 : 1),
  ) as any[];
  const ranks = new Map(
    hot.slice(0, 1000).map((p, i) => [p.a + "\0" + p.b, i]),
  );
  const common = new Set(commonWords.map((w) => w.word));
  const stats = hot.filter(
    (p) => ranks.has(p.a + "\0" + p.b) || (common.has(p.a) && common.has(p.b)),
  );
  const commonPacket = encodePairMembershipPacket(
    stats.map((p) => ({
      a: p.a,
      b: p.b,
      data: u32([
        p.df,
        p.bodyDf,
        p.titleDf,
        p.bytes,
        (ranks.get(p.a + "\0" + p.b) ?? -1) + 1,
      ]),
    })),
  );
  const objects = outputs.flatMap((o) => o.objects),
    leaves = outputs
      .flatMap((o) => o.leaves)
      .sort((a, b) => a.h - b.h || a.h2 - b.h2);
  const presence = outputs
    .flatMap((o) => o.presence)
    .sort((a, b) => a.rank - b.rank);
  if (
    presence.length !== commonWords.length ||
    presence.some(
      (p, i) =>
        p.rank !== i ||
        p.id !== commonWords[i].id ||
        p.df !== commonWords[i].df,
    )
  )
    throw Error("Incomplete common word presence");
  const metadata = {
    generation,
    baseGeneration: "",
    documents: catalogue.documents,
    targetBytes: 131072,
    contextBytes: 8192,
    namespaces: [],
    roots: [-2147483648],
    commonWords,
    completeContext: true,
    positionObjects: outputs
      .flatMap((o) => o.positionObjects)
      .map((o) => ({ id: o.id, bytes: o.size, sha256: o.sha256 })),
  };
  return {
    outputs,
    objects: [...objects, ...presence],
    coverage: {
      ...coverage,
      documents: catalogue.documents,
      completeContext: true,
    },
    leaves,
    commonPacket: Buffer.from(commonPacket).toString("base64"),
    metadata,
    presence: {
      generation,
      entries: presence.map((p) => ({ ...p, bytes: p.size, crc32: 0 })),
    },
  };
}
export function completePairRouter(
  pairs: Awaited<ReturnType<typeof buildCompletePairs>>,
  baseGeneration: string,
) {
  return encodeRangePairRouter(
    { ...pairs.metadata, baseGeneration },
    pairs.leaves,
    Buffer.from(pairs.commonPacket, "base64"),
  );
}
