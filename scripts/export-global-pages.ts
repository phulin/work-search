import { readFile, writeFile, mkdir, open } from "node:fs/promises";
import { decodeRoot } from "../src/global/format.js";
import { pageName } from "../src/global/storage.js";
const out = process.argv[2] ?? "work/global-index",
  destination = process.argv[3] ?? out + "/cdn-pages",
  budget = process.env.GLOBAL_BUDGET ?? "8",
  pageBytes = Number(process.env.GLOBAL_PAGE_KIB ?? "256") * 1024,
  { root: base } = decodeRoot(
    await readFile(out + `/bundle-heads-${budget}.bin`),
  ),
  root = { ...base, pageBytes, objectPages: (64 * 1048576) / pageBytes };
if (![65536, 131072, 262144].includes(pageBytes))
  throw Error("Page size must be 64, 128 or 256 KiB");
await mkdir(destination + "/" + root.generation, { recursive: true });
let pages = 0;
for (const [object, info] of root.objects.entries()) {
  const file = await open(out + "/packs/" + info.name, "r");
  try {
    for (let offset = 0; offset < info.size; offset += pageBytes) {
      const b = new Uint8Array(Math.min(pageBytes, info.size - offset)),
        r = await file.read(b, 0, b.length, offset);
      if (r.bytesRead !== b.length) throw Error("Truncated export pack");
      await writeFile(
        destination +
          `/${root.generation}/${pageName(root, object, offset / pageBytes)}`,
        b,
      );
      pages++;
    }
  } finally {
    await file.close();
  }
}
await writeFile(
  destination + "/manifest.json",
  JSON.stringify(
    {
      generation: root.generation,
      pageBytes,
      pages,
      bytes: root.objects.reduce((n, o) => n + o.size, 0),
    },
    null,
    2,
  ),
);
console.log("Exported immutable CDN pages", pages, destination);
