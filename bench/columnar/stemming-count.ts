import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { stem } from "stemr";
import { decodeDirectoryBlock } from "../../src/columnar/term-directory.js";
import { view } from "../../src/columnar/format.js";
import { OfflineObjects } from "../../src/columnar/offline.js";
import { benchmarkToken } from "./token.js";
const [dir, out] = process.argv.slice(2);
if (!out) throw Error("Use PACKET_INDEX OUTPUT.json");
const scoring = process.argv.includes("--scoring-root"),
  rootFile = dir + (scoring ? "/scoring-root.json" : "/root.json");
if (process.argv.includes("--wait"))
  while (
    !(await readFile(rootFile).then(
      () => true,
      (e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
        return false;
      },
    ))
  )
    await new Promise((r) => setTimeout(r, 30000));
const rootBytes = await readFile(rootFile),
  root = JSON.parse(rootBytes.toString()),
  stems = new Set<string>(),
  examples: [string, string][] = [];
let terms = 0,
  changed = 0,
  numeric = 0;
function add(word: string) {
  const normalized = stem(word);
  terms++;
  if (/^\p{N}+$/u.test(word)) numeric++;
  if (word !== normalized) {
    changed++;
    if (examples.length < 20) examples.push([word, normalized]);
  }
  stems.add(normalized);
}
let directorySha256: string | undefined;
let expectedTerms: number;
if (!scoring) {
  const bytes = await readFile(dir + "/directory.bin"),
    v = view(bytes);
  directorySha256 = createHash("sha256").update(bytes).digest("hex");
  expectedTerms = v.getUint32(4, true);
  for (let block = 0; block < v.getUint32(8, true); block++) {
    const p = 16 + block * 20,
      at = v.getUint32(p + 8, true),
      n = v.getUint32(p + 12, true);
    for (const word of decodeDirectoryBlock(
      gunzipSync(bytes.subarray(at, at + n)),
      root.count,
    ).keys()) {
      add(word);
    }
  }
} else {
  expectedTerms = JSON.parse(await readFile(dir + "/build.json", "utf8")).terms;
  const source = new OfflineObjects(dir, root, {
      url: "https://work-search-cws-upload.phulin.workers.dev",
      token: await benchmarkToken(),
    }),
    leaves: { ref: [number, number, number] }[] = [];
  async function visit(fences: typeof leaves, height: number) {
    if (!height) {
      leaves.push(...fences);
      return;
    }
    for (const fence of fences)
      await visit(
        JSON.parse(new TextDecoder().decode(await source.read(fence.ref))),
        height - 1,
      );
  }
  try {
    await visit(root.dictionaries, root.dictionaryHeight ?? 0);
    let next = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (;;) {
          const i = next++;
          if (i >= leaves.length) break;
          const entries = JSON.parse(
            new TextDecoder().decode(await source.read(leaves[i].ref)),
          );
          for (const [word] of entries) add(word);
          if (i % 500 === 0)
            console.log("Stemming dictionary", i, "/", leaves.length, terms);
        }
      }),
    );
  } finally {
    await source.close();
  }
}
if (terms !== expectedTerms) throw Error("Incomplete dictionary term coverage");
const result = {
  corpusHash: root.corpusHash,
  count: root.count,
  rootSha256: createHash("sha256").update(rootBytes).digest("hex"),
  directorySha256,
  algorithm: "English Snowball / Porter2, stemr 1.0.0",
  terms,
  stemmedTerms: stems.size,
  removed: terms - stems.size,
  reductionPercent: (100 * (terms - stems.size)) / terms,
  changedWords: changed,
  numericTerms: numeric,
  examples,
  note: "Vocabulary measurement only. No spelling correction or serving-semantic change. Not an extrapolation to another corpus.",
};
await writeFile(out, JSON.stringify(result, null, 2));
console.log(result);
