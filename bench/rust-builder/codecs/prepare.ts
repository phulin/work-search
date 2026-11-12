// Generate an explicitly experimental snapshot; production builder stays untouched.
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const out = resolve(process.argv[2] ?? "work/codec-builder-source");
await mkdir(out); // Refuse to overwrite a pinned experiment.
for (const p of ["Cargo.toml", "Cargo.lock", "crates"])
  await cp(p, out + "/" + p, { recursive: true });
const hashes: Record<string, string> = {};
async function edit(path: string, replacements: [string, string][]) {
  let text = await readFile(path, "utf8");
  hashes[path] = createHash("sha256").update(text).digest("hex");
  for (const [old, value] of replacements) {
    if (text.split(old).length !== 2)
      throw Error("Patch does not match exactly once: " + path + ": " + old);
    text = text.replace(old, value);
  }
  await writeFile(out + "/" + path, text);
}
const src = "crates/index-builder/src/";
await edit(src + "main.rs", [
  ["mod finalize;", "mod codec_experiment;\nmod finalize;"],
  [
    "        build(parse()?)",
    '        if std::env::args().nth(1).as_deref()==Some("codec-micro") { return codec_experiment::micro(&std::env::args().skip(2).collect::<Vec<_>>()); }\n        build(parse()?)',
  ],
  [
    '"builder":"rust-cws1-v2","format":"CWS1",',
    '"builder":"rust-cws1-v2-codec-experiment","codec":codec_experiment::name(),"codecVersions":codec_experiment::versions(),"format":codec_experiment::format_name(),',
  ],
]);
await edit(src + "publish.rs", [
  ['format: "CWS1",', "format: crate::codec_experiment::format_name(),"],
]);
const ingest = await readFile(src + "ingest.rs", "utf8");
const start = ingest.indexOf("struct TextCompressor {"),
  end = ingest.indexOf("fn intern(", start);
if (start < 0 || end < 0) throw Error("Compressor boundaries missing");
await edit(src + "ingest.rs", [
  [
    "use libdeflater::{CompressionLvl, Compressor};",
    "use crate::codec_experiment::{self as profile, TextCompressor};",
  ],
  [ingest.slice(start, end), ""],
  ["TextCompressor::new();", "TextCompressor::new(task.id, &dir);"],
  [
    "        let d: Document = serde_json::from_str(line)?;",
    '        let timer=profile::begin();\n        let d: Document = serde_json::from_str(line)?;\n        profile::end("json_parse",timer);',
  ],
  [
    "        let b = intern(&body,",
    "        let timer=profile::begin();\n        let b = intern(&body,",
  ],
  [
    "        let bl: u32 =",
    '        profile::end("intern",timer);\n        let bl: u32 =',
  ],
  [
    "        ids.push((d.id, doc));",
    '        ids.push((d.id, doc));\n        profile::end("position_group_pack",Some(stage));',
  ],
  [
    "    let mut postings = digest_writer",
    '    profile::end("vocab_sort_row_scatter",Some(stage));\n    let io_timer=profile::begin();\n    let mut postings = digest_writer',
  ],
  [
    "    let objects = packer.finish()?;",
    '    let objects = packer.finish()?;\n    profile::end("run_sort_write_hash",io_timer);\n    compressor.flush()?;',
  ],
  [
    "    atomic_json(&checkpoint, &run)?;",
    "    profile::finish(&dir)?;\n    atomic_json(&checkpoint, &run)?;",
  ],
]);
await edit(src + "tokenize.rs", [
  [
    "        let text: String =",
    "        let timer=crate::codec_experiment::begin();\n        let text: String =",
  ],
  [
    "        let lower = text.to_lowercase();",
    '        crate::codec_experiment::end("normalization",timer);\n        let timer=crate::codec_experiment::begin();\n        let lower = text.to_lowercase();\n        crate::codec_experiment::end("lowercase",timer);\n        let timer=crate::codec_experiment::begin();',
  ],
  [
    "        if original.is_ascii() {",
    '        crate::codec_experiment::end("word_scan",timer);\n        let timer=crate::codec_experiment::begin();\n        if original.is_ascii() {',
  ],
  [
    "            return Self { text, lower, spans };",
    '            crate::codec_experiment::end("offset_mapping",timer);\n            return Self { text, lower, spans };',
  ],
  [
    '        assert_eq!(i, spans.len(), "lowercase offset coverage");',
    '        assert_eq!(i, spans.len(), "lowercase offset coverage");\n        crate::codec_experiment::end("offset_mapping",timer);',
  ],
]);
await cp(
  "bench/rust-builder/codecs/experiment.rs",
  out + "/" + src + "codec_experiment.rs",
);
await writeFile(
  out + "/experiment-source.json",
  JSON.stringify(
    {
      kind: "Generated codec/timing experiment; non-gzip roots marked CWS1-CODEC-EXPERIMENT; never deploy as CWS1",
      sourceSha256: hashes,
      generatorSha256: createHash("sha256")
        .update(await readFile("bench/rust-builder/codecs/prepare.ts"))
        .digest("hex"),
      codecSha256: createHash("sha256")
        .update(await readFile("bench/rust-builder/codecs/experiment.rs"))
        .digest("hex"),
    },
    null,
    2,
  ) + "\n",
);
console.log(out);
