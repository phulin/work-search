import { readFile } from "node:fs/promises";
import { jsonLines } from "../src/builder/jsonl.js";
import { openIndex } from "../src/format/paged.js";
import { packCards } from "../src/content/cards-build.js";
import { cardCaseData } from "./card-case-data.js";
export async function buildInputCards(
  input: string,
  out: string,
  binary: Uint8Array,
  map: Uint8Array,
  caseGeneration: string,
) {
  const index = openIndex(binary),
    view = new DataView(map.buffer, map.byteOffset, map.byteLength),
    source = cardCaseData();
  async function* records() {
    let doc = 0;
    for await (const line of jsonLines(input)) {
      if (!line.trim()) continue;
      const original = JSON.parse(line);
      if (doc >= index.count || original.id !== index.document(doc).id)
        throw Error("Card source identity mismatch");
      yield {
        ...source.resolve(original),
        doc,
        text: original.body,
        body: Array.from({ length: 4 }, (_, i) =>
          view.getUint32(doc * 32 + i * 4, true),
        ),
      };
      doc++;
    }
  }
  try {
    return await packCards(
      out,
      index.generation,
      index.count,
      records(),
      caseGeneration,
    );
  } finally {
    source.close();
  }
}
