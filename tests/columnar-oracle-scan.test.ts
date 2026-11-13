import { expect, it } from "vitest";
import {
  OracleScan,
  type OracleContract,
} from "../bench/columnar/oracle-scan.js";

it("merges disjoint source scans into the same exact ranking including zero-score ties and fields", () => {
  const documents = [
      { doc: 0, id: "0", body: "burden of proving the claim", title: "Burden" },
      {
        doc: 1,
        id: "1",
        body: "burden of proving the burden of proving",
        title: "Claim",
      },
      { doc: 2, id: "2", body: "claim of proving", title: "Burden" },
      {
        doc: 3,
        id: "3",
        body: "burden of disproving claim",
        title: "Of proving",
      },
      { doc: 4, id: "4", body: "ÉCOLE café", title: "" },
    ],
    contracts: OracleContract[] = [
      { q: '"burden of proving"', kind: "phrase", options: { limit: 1 } },
      { q: "NOT burden", kind: "negative", options: { limit: 2 } },
      { q: "NOT missing", kind: "ties", options: { limit: 2 } },
      {
        q: '"of proving"',
        kind: "title",
        options: { field: "title", limit: 1 },
      },
      { q: "école AND café", kind: "unicode", options: { limit: 2 } },
      {
        q: 'claim AND NOT "burden of proving"',
        kind: "except",
        options: { limit: 2 },
      },
    ],
    statistics = {
      count: 5,
      avgBody: 4.2,
      avgTitle: 1,
      names: ["burden", "of", "proving", "claim", "école", "café", "missing"],
      df: [4, 4, 4, 4, 1, 1, 0],
    },
    complete = new OracleScan(statistics, contracts),
    parts = [
      new OracleScan(statistics, contracts),
      new OracleScan(statistics, contracts),
    ];
  for (const d of documents) {
    complete.add(d);
    parts[d.doc % 2].add(d);
  }
  const result = complete.result();
  expect(result.observedDf).toEqual(statistics.df);
  expect(result.plans.map((p) => p.ranked.map((d) => d.id))).toEqual([
    ["0"],
    ["4"],
    ["0", "1"],
    ["3"],
    ["4"],
    ["2", "3"],
  ]);
  for (let i = 0; i < contracts.length; i++) {
    const merged = parts
      .flatMap((p) => p.result().plans[i].ranked)
      .sort((a, b) => b.score - a.score || a.doc - b.doc)
      .slice(0, contracts[i].options?.limit ?? 20);
    expect(merged).toEqual(result.plans[i].ranked);
  }
  expect(parts.reduce((n, p) => n + p.result().bodySum, 0)).toBe(
    result.bodySum,
  );
  expect(() => new OracleScan({ ...statistics, df: [] }, contracts)).toThrow();
  expect(
    () => new OracleScan(statistics, [{ q: "unknown", kind: "invalid" }]),
  ).toThrow();
});
