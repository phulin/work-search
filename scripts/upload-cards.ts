import { readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { parallel } from "../src/storage/types.js";
export async function uploadCards(out: string, passages = false) {
  const m = JSON.parse(await readFile(out + "/manifest.json", "utf8"));
  if (
    await readFile(
      out + (passages ? "/passages-uploaded" : "/uploaded"),
      "utf8",
    ).then(
      (x) => x === m.cardGeneration,
      () => false,
    )
  )
    return;
  const { url } = JSON.parse(
      await readFile("work/full-flp/deployment.json", "utf8"),
    ),
    { INTERNAL_TOKEN: token } = JSON.parse(
      await readFile("work/full-flp/secrets.json", "utf8"),
    );
  const put = async (o: any, generation: string) => {
    for (let attempt = 0; ; attempt++)
      try {
        const r = await fetch(
          url + "/__upload/" + encodeURIComponent(generation + "/" + o.name),
          {
            method: "PUT",
            headers: {
              authorization: `Bearer ${token}`,
              "content-length": String(o.size),
              "x-sha256": o.sha256,
            },
            body: createReadStream(out + "/" + (o.fileName ?? o.name)),
            duplex: "half",
          } as any,
        );
        if (!r.ok) throw Error("Card upload " + r.status);
        break;
      } catch (e) {
        if (attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
  };
  await parallel(m.objects as any[], 3, (o) => put(o, m.cardGeneration));
  await put(
    {
      ...m.root,
      name: passages ? "passageroot-0.bin" : m.root.name,
      fileName: m.root.name,
    },
    m.indexGeneration,
  );
  await writeFile(
    out + (passages ? "/passages-uploaded" : "/uploaded"),
    m.cardGeneration,
  );
  console.log("Uploaded result cards", m.indexGeneration, m.count);
}
