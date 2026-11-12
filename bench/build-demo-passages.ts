// --all backfills every document; default builds a fixture for all recorded benchmark hits.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { packCards } from "../src/content/cards-build.js";
import type { ResultCard } from "../src/content/cards.js";
import { root, range, snapshot } from "./demo-client.js";
const artifacts = JSON.parse(await readFile(root + "/cards.json", "utf8"));
const selected = new Map<number, Set<number>>();
for (const name of ["live.json", "pages.json", "live-opt-stage3.json"]) {
  const v = await readFile(root + "/" + name, "utf8").then(
    JSON.parse,
    () => null,
  );
  for (const row of v?.rows ?? [])
    for (const h of row.body?.results ?? []) {
      const shard = snapshot.shards.find(
        (s: any) => s.generation === h.generation,
      )?.id;
      if (shard === undefined) throw Error("Unknown result generation");
      if (!selected.has(shard)) selected.set(shard, new Set());
      selected.get(shard)!.add(h.doc);
    }
}
const all = process.argv.includes("--all"),
  output = root + (all ? "/passages-all" : "/passages");
await mkdir(output, { recursive: true });
const next: Record<string, { path: string; size: number }> = {};
let docs = 0,
  sourceBytes = 0;
for (const shard of snapshot.shards) {
  const old = JSON.parse(
    await readFile(root + `/cards/${shard.id}/manifest.json`, "utf8"),
  );
  const directory = await readFile(root + `/cards/${shard.id}/cardroot-0.bin`),
    v = new DataView(
      directory.buffer,
      directory.byteOffset,
      directory.byteLength,
    );
  async function* records() {
    for (let block = 0; block < Math.ceil(old.count / 128); block++) {
      const at = 80 + block * 16,
        object = v.getUint32(at, true),
        offset = v.getUint32(at + 4, true),
        length = v.getUint32(at + 8, true);
      const file = await readFile(
        artifacts[`${old.cardGeneration}/cards-${object}.bin`].path,
      );
      const rows = JSON.parse(
        gunzipSync(file.subarray(offset, offset + length)).toString(),
      ) as ResultCard[];
      for (const card of rows) {
        let text: string | undefined;
        if (all || selected.get(shard.id)?.has(card.doc)) {
          const [object, offset, length] = card.body,
            parts: Uint8Array[] = [];
          for (let pos = 0; pos < length; pos += 4 * 1048576)
            parts.push(
              await range(
                `${shard.generation}/content-${object}.bin`,
                offset + pos,
                Math.min(4 * 1048576, length - pos),
                true,
              ),
            );
          text = gunzipSync(Buffer.concat(parts)).toString();
          sourceBytes += length;
          docs++;
        }
        yield { ...card, text };
      }
    }
  }
  const out = output + "/" + shard.id;
  let manifest = await readFile(out + "/manifest.json", "utf8").then(
    JSON.parse,
    () => null,
  );
  if (!manifest)
    manifest = await packCards(
      out,
      shard.generation,
      old.count,
      records(),
      old.caseGeneration,
    );
  for (const o of manifest.objects)
    next[manifest.cardGeneration + "/" + o.name] = {
      path: out + "/" + o.name,
      size: o.size,
    };
  next[manifest.indexGeneration + "/passageroot-0.bin"] = {
    path: out + "/cardroot-0.bin",
    size: manifest.root.size,
  };
  await writeFile(
    root + (all ? "/passages-all.json" : "/passages.json"),
    JSON.stringify(next),
  );
  console.log("Passages", shard.id, docs, sourceBytes);
}
await writeFile(
  output + "/selection.json",
  JSON.stringify({
    all,
    selected: [...selected].map(([id, docs]) => [id, [...docs]]),
    docs,
    sourceBytes,
  }),
);
