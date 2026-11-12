import { readFile, writeFile, mkdir } from "node:fs/promises";
import { root, snapshot, object } from "./demo-client.js";
import { openIndex } from "../src/format/paged.js";
import { packCards } from "../src/content/cards-build.js";
import { cardCaseData } from "../scripts/card-case-data.js";
const caseSource = cardCaseData(),
  caseGeneration = JSON.parse(
    await readFile(root + "/case-manifest.json", "utf8"),
  ).generation;
await mkdir(root + "/cards", { recursive: true });
let artifacts: any = {};
try {
  artifacts = JSON.parse(await readFile(root + "/cards.json", "utf8"));
} catch {}
const shards = process.argv.includes("--all")
  ? Object.values(
      JSON.parse(await readFile("work/full-flp/published.json", "utf8")).shards,
    ).filter((s: any) => !s.preview)
  : snapshot.shards;
for (const shard of shards as any[]) {
  if (shard.cardsAvailable) continue;
  const out = root + "/cards/" + shard.id;
  let manifest: any;
  try {
    manifest = JSON.parse(await readFile(out + "/manifest.json", "utf8"));
  } catch {
    const binary = await readFile(root + "/bundles/" + shard.id + ".bin").catch(
      () => object(shard.generation + "/bundle-0.bin"),
    );
    const index = openIndex(binary),
      view = index.queryIndex();
    const objects = new Map<string, Uint8Array>();
    const storage = {
      read: async (key: string, offset: number, length: number) => {
        if (!objects.has(key)) objects.set(key, await object(key));
        return objects.get(key)!.subarray(offset, offset + length);
      },
    };
    await view.resolveDocuments(
      Array.from({ length: index.count }, (_, i) => i),
      storage,
      true,
    );
    const map = await object(index.generation + "/contentmap-0.bin"),
      mv = new DataView(map.buffer, map.byteOffset, map.byteLength);
    async function* records() {
      for (let doc = 0; doc < index.count; doc++) {
        const d = view.document(doc),
          bytes = await storage.read(
            view.key(d.metaObject, "metadata"),
            d.metaOffset,
            d.metaLength,
          ),
          original = JSON.parse(new TextDecoder().decode(bytes));
        if (original.id !== d.id) throw Error("Card source identity mismatch");
        const info = caseSource.resolve(original);
        yield {
          ...info,
          doc,
          body: Array.from({ length: 4 }, (_, i) =>
            mv.getUint32(doc * 32 + i * 4, true),
          ),
        };
      }
    }
    manifest = await packCards(
      out,
      index.generation,
      index.count,
      records(),
      caseGeneration,
    );
  }
  for (const o of manifest.objects)
    artifacts[manifest.cardGeneration + "/" + o.name] = {
      path: out + "/" + o.name,
      size: o.size,
    };
  artifacts[manifest.indexGeneration + "/cardroot-0.bin"] = {
    path: out + "/cardroot-0.bin",
    size: manifest.root.size,
  };
  await writeFile(root + "/cards.json", JSON.stringify(artifacts, null, 2));
  console.log("Packed result cards", shard.id, manifest.count);
}
caseSource.close();
