import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { assembleTermDirectory } from "../src/columnar/term-directory.js";

/** Bundle metadata as soon as term jobs finish. Keep validated small blocks
 * locally so a resumed coordinator does not repeat thousands of remote reads. */
export async function packetDirectory(
  state: any,
  out: string,
  uploader: string,
  token: string,
) {
  const blocks = state.terms
    .flatMap((job: any) => job.blocks.map((block: any) => ({ ...block })))
    .sort((a: any, b: any) =>
      a.first < b.first ? -1 : a.first > b.first ? 1 : 0,
    );
  await mkdir(out + "/directory-blocks", { recursive: true });
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (;;) {
        const i = next++;
        if (i >= blocks.length) break;
        const b = blocks[i],
          file = out + "/directory-blocks/" + b.ref.sha256 + ".bin";
        const valid = (bytes: Uint8Array) =>
          bytes.length === b.ref.size &&
          createHash("sha256").update(bytes).digest("hex") === b.ref.sha256;
        let data = await readFile(file).catch(() => undefined);
        if (!data || !valid(data)) {
          for (let retry = 0; ; retry++)
            try {
              const response = await fetch(`${uploader}/${b.ref.key}`, {
                headers: { authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(60000),
              });
              if (!response.ok)
                throw Error("Directory block read " + response.status);
              const downloaded = Buffer.from(await response.arrayBuffer());
              if (!valid(downloaded))
                throw Error("Directory block identity mismatch");
              await writeFile(file, downloaded);
              data = downloaded;
              break;
            } catch (error) {
              if (retry === 5) throw error;
              await new Promise((r) => setTimeout(r, 500 * 2 ** retry));
            }
        }
        b.data = data;
      }
    }),
  );
  const directory = assembleTermDirectory(blocks),
    terms = state.terms.reduce((n: number, j: any) => n + j.completedTerms, 0),
    bodyOccurrences = state.terms.reduce(
      (n: number, j: any) => n + j.bodyOccurrences,
      0,
    ),
    titleOccurrences = state.terms.reduce(
      (n: number, j: any) => n + j.titleOccurrences,
      0,
    );
  await writeFile(out + "/directory.bin", directory);
  return { directory, terms, bodyOccurrences, titleOccurrences };
}
