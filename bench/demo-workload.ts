// Scenario coverage, not a claim about real user-query frequencies.
export const demoWorkload = [
  { q: "summary judgment", kind: "plain-common" },
  { q: "personal jurisdiction", kind: "plain-common" },
  { q: "breach fiduciary duty", kind: "plain-selective" },
  { q: "arbitrary capricious agency", kind: "plain-selective" },
  { q: '"clear and convincing evidence"', kind: "phrase" },
  { q: '"res ipsa loquitur"', kind: "phrase-rare" },
  { q: "(standing OR mootness) AND jurisdiction", kind: "boolean" },
  { q: "(copyright OR trademark) AND injunction", kind: "boolean" },
  { q: "qualified AND immunity NOT prison", kind: "boolean-not" },
  { q: "qualified /s immunity", kind: "proximity" },
  { q: "contract /10 breach", kind: "proximity" },
  { q: "notice /p termination", kind: "proximity" },
  { q: "Christenberry Allen", kind: "case-name" },
  { q: "Twombly Iqbal", kind: "case-name" },
  { q: "court", kind: "broad-stress" },
  { q: "unfindablebenchmarkzzzz", kind: "empty-control" },
];
