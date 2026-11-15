# Construction baseline at the redesign boundary

The working tree at the start of the construction redesign is archived in
`work/construction-v3/control/source.tar` (SHA256
`71a29105af89bbfa058c0666093707e71f40d48ad62230bf61bdd2de60b849c4`).
Its parent commit is `861964ca3be161d7cd70fc0252651f208f6da00a`.
The audit is `work/construction-review-20261115.json`. This is a partial-build
diagnostic, not a matched end-to-end control or a billing report.

The retained baseline removes the standalone vocabulary loop for fresh builds,
resolves IDs while packaging, and uses a compact common dictionary with complete
remote fallback. The full court dictionary has 12,327,129 terms in 178 packets
(45,645,623 bytes); the sampled common bundle contains 437,921 terms and costs
3,384,094 bytes including global IDs. These are not exact global top-DF terms.

A disposable native Worker pilot compared four disjoint 128-document ranges,
two repetitions each, empty application dictionary caches. Raw results:
`work/vocabulary-read-fix/live/results.json`. Opaque R2 caches were uncontrolled.
Vocabulary and package hashes matched in every comparison. The control package
encoder shares the new batching code; this is not a frozen old end-to-end build.

| First document | Vocabulary + seeded packaging ms | Direct packaging ms | GETs before / after |
|---:|---:|---:|---:|
| 0 | 26,963 | 1,139 | 4,376 / 12 |
| 1,000,000 | 36,619 | 3,923 | 4,804 / 145 |
| 5,776,227 | 44,293 | 2,831 | 5,417 / 178 |
| 8,000,000 | 36,022 | 5,359 | 5,075 / 168 |

The first range overlaps dictionary sampling; the remaining ranges include cold
tail words. This establishes a useful baseline improvement, not the new pipeline's
end-to-end targets. The pilot deployment was deleted. The old full-corpus build
was stopped intentionally; its immutable artifacts and checkpoint remain intact.

Validation before the redesign: `yarn run check`, 329 Vitest tests, and
`git diff --check` passed. The independent source-prefetch, merge-planning, and
tier-directory edits in the working tree are retained separately.
