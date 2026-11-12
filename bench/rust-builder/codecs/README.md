# Reproduce ingestion and codec diagnostics

Production builder source is untouched. `prepare.ts` makes a fresh pinned source
snapshot and injects timers/codec experiments there. It refuses to overwrite an
existing experiment directory. Non-gzip roots are marked as experimental and must
never be published as CWS1. Use fresh outputs, not resume, for these comparisons.

On the measured Mac this uses the already installed Homebrew `zstd`, `lz4` and
`brotli` C libraries under `/opt/homebrew/lib`, plus the normal locked Rust crate
dependencies. Other machines need matching libraries/linker paths; these native
FFI dependencies do not enter the production builder. Offline construction can use
Rust; yarn/TypeScript orchestrates the measurements.

```sh
yarn node --import tsx bench/rust-builder/codecs/prepare.ts work/codec-source
RUSTFLAGS='-L native=/opt/homebrew/lib' cargo build --release --locked --offline --manifest-path work/codec-source/Cargo.toml
# Detailed profile and sample every 64th actual serialized text record:
CODEC_PROFILE=1 CODEC_FIXTURES=1 yarn node --import tsx bench/rust-builder/codecs/run.ts /path/corpus.jsonl work/codec-source work/profile 100000 1 gzip
work/codec-source/target/release/work-search-builder codec-micro work/profile/100000-0-gzip work/micro-fixtures > work/micro.jsonl
# Separate sequential complete-build session; do not overlap other benchmarks:
CODEC_PROFILE=1 CODEC_KEEP=zstd-1 yarn node --import tsx bench/rust-builder/codecs/run.ts /path/corpus.jsonl work/codec-source work/codec-builds 100000 3 gzip,zstd-1,zstd-fast3
# Last CODEC_KEEP build is retained; other large packs/staging are reclaimed.
yarn node --import tsx bench/rust-builder/codecs/verify.ts work/codec-builds/100000-2-zstd-1 /path/oracle.json /path/gzip-native-index
```

Compile the optional standalone bounded LZ4 decoder (no libc/WASI imports):

```sh
clang --target=wasm32 -O3 -msimd128 -fno-builtin -c bench/rust-builder/codecs/lz4.c -o work/lz4.o
# wasm-ld is available in the Rust toolchain on the measured machine:
"$(rustc --print sysroot)/lib/rustlib/aarch64-apple-darwin/bin/gcc-ld/wasm-ld" --no-entry --export=decode --export=input_ptr --export=output_ptr --export-memory --initial-memory=18874368 --max-memory=18874368 --strip-all work/lz4.o -o work/lz4.wasm
# Point to the direct native executable, not workerd's Node launcher (which drops fd 3).
CODEC_LZ4_WASM=work/lz4.wasm CODEC_COMPAT_DATE=2026-11-10 MINIFLARE_WORKERD_PATH=/path/to/native/workerd yarn node --import tsx bench/rust-builder/codecs/decode.ts work/micro-fixtures work/decode.json
```

The included [decoder artifact](results/lz4.wasm) is only 1,061 bytes; its fixed
18 MiB memory and all buffer bounds are part of the comparison. Omit
`CODEC_LZ4_WASM` to run the native/JS comparisons alone. `CODEC_COMPAT_DATE` defaults
to 2026-08-06 for the older nested Miniflare runtime. The report's final measurements
explicitly use the current installed November 10 binary. The harness records its
version and actual binary SHA, not merely an npm package version.

The decoder harness verifies every sampled Zstandard and WASM LZ4 payload, tests
valid neighboring/boundary lengths and truncated Zstandard frames, then measures
five warmed batches per codec/class. Valid-frame failures in the default Zstandard
path are deliberately recorded; the `info: true` alternate path must pass.

[Findings and qualifications](REPORT.md) · [Machine summary](results/summary.json)
