# Rust CWS1 index builder

Build the base packed index directly from source documents. Serving stays in the
TypeScript Worker. Requires a C compiler, Rust 1.93, yarn, and Node.js with Unicode
17.0 (benchmarked with Node 26.7.0). The builder checks Unicode versions rather
than silently changing tokenization.

```sh
yarn builder:compile
yarn builder:index --input /path/corpus.jsonl --out work/native-index --threads 8
# Reuse and validate completed checkpoints after an interrupted build:
yarn builder:index --input /path/corpus.jsonl --out work/native-index --threads 8 --resume
# Multiple source partitions, in ordinal document order:
yarn builder:index --input /path/part-000.jsonl --input /path/part-001.jsonl --out work/native-index
```

Arguments: `--input` (repeatable), `--out`, `--threads` (1–64), `--batch-mib`
(default 4, at most 64), `--max-docs`, and `--resume`. Input is uncompressed UTF-8
JSONL with `{id, body, title?, metadata?}` records. IDs must be nonempty and unique;
`metadata: null` is preserved. `title`, if present, must be a string. Empty bodies
are valid. The parser rejects records over 64 MiB before allocating the full line.

Publish `root.json` and `packs/` together under a generation-scoped R2 prefix.
`manifest.json` records input identity and stage timings. Existing CWS1 deployment
tooling can consume this output. Do not mix root and objects from different builds.
The content-derived generation changes with physical layout, including batch size.
A finished generation is immutable; use a fresh output directory for changed input.
Keep `staging/` if checkpoint/resume validation is needed; serving does not use it.

```sh
yarn builder:check
yarn builder:test
yarn run check
yarn test
# Real complete builds: compile first; avoid competing local builds when possible.
yarn bench:builder /path/corpus.jsonl work/build-bench 1000,10000 3 4
# Frozen first-Rust comparison (see REPORT.md for control preparation):
BUILDER_VARIANTS=rust-v1,rust BENCH_CLEAN=1 yarn bench:builder /path/corpus.jsonl work/rust-compare 100000 3 4
# Query correctness against a pinned existing oracle:
yarn node --import tsx bench/rust-builder/verify.ts work/native-index /path/oracle.json
```

Benchmark variants: `typescript` (frozen benchmark builder), `rust` (current release
binary), and `rust-v1` (frozen control artifact). Builds run sequentially, reversing
variant order each round. `BENCH_CLEAN=1` removes each measured build's packs and
staging after recording results, preserving roots/manifests/logs. Set
`BENCH_KEEP_LAST_RUST=1` to retain the final Rust index for verification. This is
useful when repeated complete builds would fill the local disk. Compilation and
cleanup are outside measured build wall time. OS caches remain uncontrolled.

[Design](DESIGN.md) · [Measured results](REPORT.md)
