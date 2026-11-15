import { expect, it } from "vitest";
import { courtCaseDecision } from "../scripts/court-case-policy.js";
it("includes judicial cases and excludes AGs and administrative decisions even in mixed categories", () => {
  for (const [id, jurisdiction] of [
    ["scotus", "F"],
    ["arizsuper", "ST"],
    ["ganb", "FB"],
    ["tax", "FS"],
    ["jpml", "FS"],
    ["ohctapp1", ""],
  ])
    expect(courtCaseDecision(id, { jurisdiction })).toBe("include");
  for (const [id, jurisdiction] of [
    ["ag", "FS"],
    ["olc", "FS"],
    ["minnag", "SAG"],
    ["oklaag", "SS"],
    ["ptab", "FS"],
    ["bta", "FS"],
    ["ohiotax", "SS"],
    ["ohiocivright", "C"],
    ["nyarbct", "SS"],
    ["test", "T"],
    ["masstaxbd", "SA"],
    ["njpuc", "ST"],
  ])
    expect(courtCaseDecision(id, { jurisdiction })).toBe("non-court");
  expect(courtCaseDecision(null, undefined)).toBe("unknown-court");
  expect(courtCaseDecision("new", { jurisdiction: "NEW" })).toBe("non-court");
});
