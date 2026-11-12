import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { deploy } from "./deploy-demo.js";
import { parallel } from "../src/storage/types.js";
const source = "bench/generated/flp-100000/opt6-8",
  manifest = JSON.parse(await readFile(source + "/manifest.json", "utf8")),
  viewer = JSON.parse(
    await readFile("work/global-baseline/viewer/viewer-manifest.json", "utf8"),
  );
const { url } = JSON.parse(
    await readFile("work/full-flp/deployment.json", "utf8"),
  ),
  { INTERNAL_TOKEN: token } = JSON.parse(
    await readFile("work/full-flp/secrets.json", "utf8"),
  );
const cards = JSON.parse(
  await readFile("work/global-baseline/cards-8/manifest.json", "utf8"),
);
const objects = [
  ...cards.objects.map((o: any) => ({
    ...o,
    key: cards.cardGeneration + "/" + o.name,
    file: "work/global-baseline/cards-8/" + o.name,
  })),
  {
    ...cards.root,
    key: manifest.generation + "/globalbenchcardroot-0.bin",
    file: "work/global-baseline/cards-8/cardroot-0.bin",
  },
  ...manifest.objects.map((o: any) => ({
    ...o,
    file: source + "/objects/" + o.key,
  })),
  ...viewer.objects.map((o: any) => ({
    ...o,
    key: manifest.generation + "/" + o.name,
    file: "work/global-baseline/viewer/" + o.name,
  })),
];
if (!process.argv.includes("--deploy-only"))
  await parallel(objects, 6, async (o: any) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(url + "/__upload/" + encodeURIComponent(o.key), {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "content-length": String(o.size),
            "x-sha256": o.sha256,
          },
          body: createReadStream(o.file),
          duplex: "half",
        } as any);
        if (!r.ok) throw Error("Baseline upload " + r.status);
        break;
      } catch (e) {
        if (attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    console.log("Baseline upload", o.key);
  });

await mkdir("work/global-deploy", { recursive: true });
const entry = resolve("work/global-deploy/legacy-leaf.ts");
await writeFile(
  entry,
  `import bytes from ${JSON.stringify(resolve(source + "/bundle.bin"))};import {createShard} from ${JSON.stringify(resolve("demo/shard-runtime.ts"))};import {SearchRuntime} from ${JSON.stringify(resolve("src/query/runtime.ts"))};const runtime=new SearchRuntime(4*1048576),handler=createShard(new Uint8Array(bytes),runtime);export default {fetch(request:Request,env:any){if(new URL(request.url).pathname==="/internal/reset"&&request.headers.get("authorization")=== "Bearer "+env.INTERNAL_TOKEN){runtime.clear();return new Response("Reset");}return handler.fetch(request,env);}};`,
);
await deploy("work-search-global-old-leaf", entry, { SHARD_ID: "0" });
await deploy("work-search-global-old", "bench/global-native-baseline.ts", {}, [
  { binding: "PART", service: "work-search-global-old-leaf" },
]);
