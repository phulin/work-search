import { readFile, writeFile } from "node:fs/promises";
import { deepStrictEqual } from "node:assert/strict";
const [referencePath, candidatePath, out] = process.argv.slice(2);
if (!out)
  throw Error(
    "Usage: compare-oracles.ts REFERENCE.json CANDIDATE.json OUTPUT.json",
  );
const reference = JSON.parse(await readFile(referencePath, "utf8")),
  candidate = JSON.parse(await readFile(candidatePath, "utf8")),
  a = reference.plans ?? reference.scenarios,
  b = candidate.plans ?? candidate.scenarios;
for (const key of [
  "first",
  "next",
  "count",
  "bodySum",
  "titleSum",
  "names",
  "observedDf",
  "expectedDf",
  "corpusHash",
])
  if (reference[key] !== undefined)
    deepStrictEqual(candidate[key], reference[key], key);
deepStrictEqual(b.length, a.length, "Contract count");
let scores = 0,
  maxRelativeScoreDifference = 0;
for (let i = 0; i < a.length; i++) {
  deepStrictEqual(b[i].q, a[i].q, "Query " + i);
  deepStrictEqual(b[i].kind, a[i].kind, "Class " + i);
  deepStrictEqual(
    { ...b[i].options, after: undefined },
    { ...a[i].options, after: undefined },
    "Options " + i,
  );
  if (a[i].options?.after) {
    deepStrictEqual(
      b[i].options?.after?.doc,
      a[i].options.after.doc,
      "Cursor document " + i,
    );
    if (
      Math.abs(b[i].options.after.score - a[i].options.after.score) >
      1e-11 * Math.max(1, Math.abs(a[i].options.after.score))
    )
      throw Error("Cursor score " + i);
  }
  const x = a[i].ranked ?? a[i].oracle,
    y = b[i].ranked ?? b[i].oracle;
  deepStrictEqual(y.length, x.length, "Result count " + i);
  for (let j = 0; j < x.length; j++) {
    for (const key of ["doc", "id", "title", "metadata"])
      deepStrictEqual(y[j][key], x[j][key], `${i}:${j}:${key}`);
    const difference =
      Math.abs(x[j].score - y[j].score) / Math.max(1, Math.abs(x[j].score));
    if (!Number.isFinite(difference) || difference > 1e-11)
      throw Error(`Score mismatch ${i}:${j}`);
    maxRelativeScoreDifference = Math.max(
      maxRelativeScoreDifference,
      difference,
    );
    scores++;
  }
}
const result = {
  referencePath,
  candidatePath,
  documents: candidate.count,
  contracts: a.length,
  scores,
  identitiesAndDisplayMetadataIdentical: true,
  crossRuntimeRelativeTolerance: 1e-11,
  maxRelativeScoreDifference,
  independentDfVerified: candidate.independentDfVerified,
  independentGlobalStatsVerified: candidate.independentGlobalStatsVerified,
};
await writeFile(out, JSON.stringify(result, null, 2));
console.log(result);
