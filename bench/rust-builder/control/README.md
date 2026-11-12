# Frozen CWS1 benchmark/reference tools

`build.ts` and `format.ts` snapshot the initial source-partition CWS1 TS builder,
with relative imports adjusted for this directory. `run.ts` is its benchmark entry
point. `search.ts` and `storage.ts` snapshot the reader used to verify native build
results against the existing query oracle. These files are deliberately kept out
of the production path. They depend on shared tokenization/parser/codec helpers
from the base repository commit dd08b3c943362af8a3d404ed5cb6bc28d402b914.

The first Rust implementation is frozen separately at
`codex/rust-builder-v1-control` (8e66d77743b326662dbdc608593e3cca8860e29c).
The production native builder has no V8 scoring subprocess or legacy fallback.
