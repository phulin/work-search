import { readFile, writeFile, mkdir } from "node:fs/promises";
import { packOpinions } from "../src/content/pack.js";
import { packCards } from "../src/content/cards-build.js";
import { BinaryIndex } from "../src/format/index.js";
import { jsonLines } from "../src/builder/jsonl.js";
const out = "work/global-baseline",
  input = "bench/generated/flp-100000/corpus.jsonl",
  source = new BinaryIndex(
    await readFile("bench/generated/flp-100000/source/bundle.bin"),
  );
await mkdir(out, { recursive: true });
if (
  !(await readFile(out + "/viewer/viewer-manifest.json").then(
    () => true,
    () => false,
  ))
)
  await packOpinions(
    input,
    out + "/viewer",
    source.count,
    (i) => source.document(i).id,
  );
const map = await readFile(out + "/viewer/contentmap-0.bin"),
  v = new DataView(map.buffer, map.byteOffset, map.byteLength);
async function* cards() {
  let doc = 0;
  for await (const line of jsonLines(input)) {
    if (!line.trim()) continue;
    const d = JSON.parse(line);
    yield {
      doc,
      id: d.id,
      title: d.title,
      metadata: d.metadata,
      body: Array.from({ length: 4 }, (_, i) =>
        v.getUint32(doc * 32 + i * 4, true),
      ),
    };
    doc++;
  }
}
const manifests: Record<string, any> = {};
for (const budget of [8, 16, 32, 48]) {
  const binary = await readFile(
      `bench/generated/flp-100000/opt6-${budget}/bundle.bin`,
    ),
    { openIndex } = await import("../src/format/paged.js"),
    index = openIndex(binary),
    dir = out + `/cards-${budget}`;
  const manifest =
    (await readFile(dir + "/manifest.json", "utf8").then(
      JSON.parse,
      () => null,
    )) ??
    (await packCards(
      dir,
      index.generation,
      index.count,
      cards(),
      "0".repeat(64),
    ));
  manifests[budget] = manifest;
  console.log("Baseline cards", budget, index.generation);
}
await writeFile(out + "/cards.json", JSON.stringify(manifests));
