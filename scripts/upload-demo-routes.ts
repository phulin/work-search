import { readFile, copyFile, rename } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { parallel } from "../src/storage/types.js";
import { decodeRoutes } from "../src/format/routes.js";
const flag = process.argv.indexOf("--out");
if (flag >= 0 && !process.argv[flag + 1])
  throw Error("--out requires a directory");
const out = flag >= 0 ? process.argv[flag + 1] : "work/demo-bench/routes",
  manifest = JSON.parse(await readFile(out + "/manifest.json", "utf8"));
const root = decodeRoutes(await readFile(out + "/root.bin"));
if (root?.generation !== manifest.generation)
  throw Error("Routing manifest mismatch");
const { url } = JSON.parse(
    await readFile("work/full-flp/deployment.json", "utf8"),
  ),
  { INTERNAL_TOKEN: token } = JSON.parse(
    await readFile("work/full-flp/secrets.json", "utf8"),
  );
await parallel(manifest.objects as any[], 3, async (o) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(
        url +
          "/__upload/" +
          encodeURIComponent(manifest.generation + "/" + o.name),
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "content-length": String(o.size),
            "x-sha256": o.sha256,
          },
          body: createReadStream(out + "/" + o.name),
          duplex: "half",
        } as any,
      );
      if (!r.ok) throw Error("Routing upload " + r.status);
      break;
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  console.log("Uploaded", o.name, o.size);
});
// Publish the complete bundle pointer only after every immutable object exists.
await copyFile(out + "/root.bin", "data/global-routes.bin.next");
await rename("data/global-routes.bin.next", "data/global-routes.bin");
console.log("Routing objects ready", manifest.generation);
