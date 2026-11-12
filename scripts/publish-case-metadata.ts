import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { parallel } from "../src/storage/types.js";

const root = "work/full-flp";
if (process.argv.includes("--wait")) {
  while (
    !(await readFile(root + "/case-metadata/manifest.json").then(
      () => true,
      () => false,
    ))
  ) {
    await new Promise((r) => setTimeout(r, 5000));
  }
}
const { url } = JSON.parse(await readFile(root + "/deployment.json", "utf8")),
  { INTERNAL_TOKEN: token } = JSON.parse(
    await readFile(root + "/secrets.json", "utf8"),
  ),
  manifest = JSON.parse(
    await readFile(root + "/case-metadata/manifest.json", "utf8"),
  );

await parallel(manifest.objects as any[], 3, async (o) => {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(
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
        body: createReadStream(root + "/case-metadata/" + o.name),
        duplex: "half",
      } as any,
    );
    if (response.ok) break;
    if (attempt >= 5)
      throw Error(`Metadata upload ${o.name}: ${response.status}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("Uploaded case metadata", o.name, o.size);
});
const response = await fetch(url + "/__case-metadata", {
  method: "PUT",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(manifest),
});
if (!response.ok)
  throw Error(
    "Metadata publish failed " +
      response.status +
      " " +
      (await response.text()),
  );
console.log("Published", manifest.generation, manifest.statistics);
