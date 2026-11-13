import type { Root } from "../src/columnar/format.js";
import type { VocabularyRoot } from "../src/columnar/construction/vocabulary.js";
import { OfflineObjects } from "../src/columnar/offline.js";
import { Reader } from "../src/columnar/storage.js";
/** Read only upper dictionary nodes. The projected root needs none of the
 * scoring/position object directory, so its size scales with vocabulary pages. */
export async function vocabularyRoot(
  dir: string,
  root: Root,
  idRouting: VocabularyRoot["idRouting"],
  token: string,
): Promise<VocabularyRoot> {
  const source = new OfflineObjects(dir, root, {
      url: "https://work-search-cws-upload.phulin.workers.dev",
      token,
    }),
    reader = new Reader(root, source.source);
  try {
    return await projectVocabularyRoot(root, idRouting, reader);
  } finally {
    await source.close();
  }
}
export async function projectVocabularyRoot(
  root: Root,
  idRouting: VocabularyRoot["idRouting"],
  reader: Reader,
): Promise<VocabularyRoot> {
  const ids = new Set<number>();
  const visit = async (
    fences: Root["dictionaries"],
    height: number,
  ): Promise<void> => {
    await Promise.all(
      fences.map(async (fence) => {
        ids.add(fence.ref[0]);
        if (height)
          await visit(
            await reader.load(
              fence.ref,
              (bytes) =>
                JSON.parse(
                  new TextDecoder().decode(bytes),
                ) as Root["dictionaries"],
              fence.ref[2] * 3,
            ),
            height - 1,
          );
      }),
    );
  };
  await visit(idRouting.dictionaries, idRouting.dictionaryHeight ?? 0);
  const objects: Root["objects"] = [],
    objectIds: number[] = [];
  root.objects.forEach((object, i) => {
    const id = root.objectIds?.[i] ?? i;
    if (ids.has(id)) {
      objects.push({
        ...object,
        key: object.key ?? `${root.generation}/${object.name}`,
      });
      objectIds.push(id);
    }
  });
  if (objects.length !== ids.size)
    throw Error("Vocabulary directory references an absent object");
  return {
    generation: root.generation,
    count: root.count,
    objects,
    objectIds,
    idRouting,
  };
}
