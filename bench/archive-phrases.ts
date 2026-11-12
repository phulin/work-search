import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
const out = "bench/results/phrases-v1";
await mkdir(out, { recursive: true });
const names = [
  "phrase-native-step1",
  "phrase-native-step2",
  "phrase-native-multi",
  "phrase-native-final",
  ...["phrase128", "phrase-final"].flatMap((prefix) =>
    [8, 16, 32, 48].flatMap((mib) => [
      `${prefix}-${mib}-empirical`,
      `${prefix}-${mib}-local-cpu`,
    ]),
  ),
  "phrase32-step2-cpu",
  "adaptive-expanded-cpu",
  "adaptive-probe-latency",
  "adaptive-probe-advice-latency",
];
for (const name of names) {
  const bytes = await readFile(`work/global-bench/${name}.json`);
  const data = JSON.parse(bytes.toString());
  if (
    /^phrase(?:128|\-final)-\d+-(?:empirical|local-cpu)$/.test(name) &&
    data.rows.length !== 96
  )
    throw Error("Incomplete matrix " + name);
  if (
    name.startsWith("phrase-native") &&
    data.rows.length !== (name.endsWith("final") ? 192 : 128)
  )
    throw Error("Incomplete native run " + name);
  await writeFile(`${out}/${name}.json.gz`, gzipSync(bytes, { level: 9 }));
}
const pairDirs = [
  "pairs-100k-v4096-utility32",
  "pairs-100k-v4096-utility128",
  "pairs-100k-v4096-inline256",
];
for (const dir of pairDirs) {
  await copyFile(`work/${dir}/manifest.json`, `${out}/${dir}-manifest.json`);
  await writeFile(
    `${out}/${dir}-root.bin.gz`,
    gzipSync(await readFile(`work/${dir}/pairs.bin`), { level: 9 }),
  );
  const file = dir.endsWith("inline256")
    ? "coverage.jsonl"
    : "selectivity.jsonl";
  await copyFile(`work/${dir}/${file}`, `${out}/${dir}-${file}`);
}
await copyFile(
  "work/pairs-4096-coverage.json",
  out + "/vocabulary-coverage.json",
);
await writeFile(
  out + "/oracle.json.gz",
  gzipSync(await readFile("work/global-bench/competitive-oracle.json"), {
    level: 9,
  }),
);
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bundles = [];
for (const mib of [8, 16, 32, 48]) {
  const b = await readFile(`work/global-100k/bundle-heads-${mib}.bin`);
  bundles.push({
    mib,
    bytes: b.length,
    sha256: hash(b),
    finalCombinedBytes: b.length + 151816,
  });
}
const code: Record<string, string> = {};
for (const file of [
  "search",
  "pairs",
  "pair-build",
  "pair-search",
  "storage",
  "worker-runtime",
])
  code[file + ".ts"] = hash(await readFile(`src/global/${file}.ts`));
await writeFile(
  out + "/manifest.json",
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      baselineCommit: "b7f6560",
      source: JSON.parse(
        await readFile(
          "bench/generated/flp-100000/source/manifest.json",
          "utf8",
        ),
      ),
      base: JSON.parse(
        await readFile("work/global-100k/manifest.json", "utf8"),
      ),
      bundles,
      codeSha256: code,
      calibration: "../global-v1/calibration.json.gz",
      notes:
        "Native 8MiB only; four-budget local matrix. Baseline and first probe preserved as explicit controls. Full corpus production demo unchanged.",
    },
    null,
    2,
  ),
);
console.log("Archived", names.length, "result files into", out);
