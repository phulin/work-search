import { writeFile } from "node:fs/promises";
import { benchmarkToken } from "./token.js";
const token = await benchmarkToken(),
  rows = [];
for (const name of process.argv.slice(2)) {
  const url = `https://${name}.phulin.workers.dev`,
    health = await fetch(url + "/health", {
      headers: { authorization: `Bearer ${token}` },
    });
  if (!health.ok) throw Error("Placement health " + name + " " + health.status);
  const row: any = {
    name,
    placement: health.headers.get("cf-placement"),
    health: await health.json(),
  };
  if (name.startsWith("work-search-cws-build-")) {
    const response = await fetch(url + "/probe-io", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    if (!response.ok) throw Error("R2 placement probe " + response.status);
    row.r2 = await response.json();
    row.probePlacement = response.headers.get("cf-placement");
  }
  rows.push(row);
  console.log(JSON.stringify(row));
}
await writeFile(
  "work/columnar-worker-build/placement.json",
  JSON.stringify(
    {
      at: new Date().toISOString(),
      bucketLocation: "ENAM",
      configuredRegion: "aws:us-east-1",
      rows,
    },
    null,
    2,
  ),
);
