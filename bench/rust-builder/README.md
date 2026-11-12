# Rust CWS1 index builder

Build the base packed index directly from source documents. Serving stays in the
TypeScript Worker. Requires a C compiler, Rust 1.93, yarn, and Node.js with Unicode
17.0 (benchmarked with Node 26.7.0). The builder checks Unicode versions rather
than silently changing tokenization.

```sh
yarn builder:compile
yarn builder:index --input /path/corpus.jsonl --out work/native-index --threads 8 --batch-mib 16
# Reuse and validate completed checkpoints after an interrupted build:
yarn builder:index --input /path/corpus.jsonl --out work/native-index --threads 8 --batch-mib 16 --resume
# Multiple source partitions, in ordinal document order:
yarn builder:index --input /path/part-000.jsonl --input /path/part-001.jsonl --out work/native-index
```

Arguments: `--input` (repeatable), `--out`, `--threads` (1–64), `--batch-mib`
(default 4, at most 64), `--max-docs`, and `--resume`. Input is uncompressed UTF-8
JSONL with `{id, body, title?, metadata?}` records. IDs must be nonempty and unique;
`metadata: null` is preserved. `title`, if present, must be a string. Empty bodies
are valid. The parser rejects records over 64 MiB before allocating the full line.

Publish `root.json` and `packs/` together under a generation-scoped R2 prefix.
`manifest.json` records input identity and stage timings. A publisher must use the
generation in the completed root. The older source-hash streaming uploader needs adaptation before it can upload/delete native objects
as construction progresses. Do not mix root and objects from different builds.
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
# Latest matched comparison (see REPORT.md for control preparation):
BUILDER_VARIANTS=rust-v2,rust BENCH_CLEAN=1 yarn bench:builder /path/corpus.jsonl work/rust-compare 100000 3 8 16
# Query correctness against a pinned existing oracle:
yarn node --import tsx bench/rust-builder/verify.ts work/native-index /path/oracle.json
```

Benchmark variants: `typescript` (frozen benchmark builder), `rust` (current release
binary), `rust-v1` (first Rust control), and `rust-v2` (previous optimized control). Builds
run sequentially, reversing variant order each round. `BENCH_CLEAN=1` removes each measured build's packs and
staging after recording results, preserving roots/manifests/logs. Set
`BENCH_KEEP_LAST_RUST=1` to retain the final Rust index for verification. This is
useful when repeated complete builds would fill the local disk. Compilation and
cleanup are outside measured build wall time. OS caches remain uncontrolled.

For large corpora on the measured M3, eight threads / 16 MiB batches perform well
at about 2–2.5 GiB peak RSS. The 4 MiB default remains useful for small corpora.
Input may also be a named FIFO. Compile before starting the decompressor, and
check both exit statuses:

```sh
yarn builder:compile
mkdir -p work
mkfifo work/native-input.jsonl
gzip -dc /path/corpus.jsonl.gz > work/native-input.jsonl &
builder_input_pid=$!
yarn builder:index --input work/native-input.jsonl --out work/native-index --threads 8 --batch-mib 16
builder_build_status=$?
if [ "$builder_build_status" -ne 0 ]; then
  kill "$builder_input_pid" 2>/dev/null || true
fi
wait "$builder_input_pid"
builder_input_status=$?
rm work/native-input.jsonl
test "$builder_build_status" -eq 0 && test "$builder_input_status" -eq 0
```

The source must be streamed again when validating resume. Avoid `--max-docs` with
an unbounded FIFO producer unless producer shutdown is handled explicitly.

[Design](DESIGN.md) · [Measured results](REPORT.md)
