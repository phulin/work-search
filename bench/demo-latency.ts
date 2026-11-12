import { writeFile } from "node:fs/promises";
import { root, snapshot, remote } from "./demo-client.js";
let state = 20261111;
const random = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 4294967296;
};
const objects: any[] = [];
for (const fraction of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
  const s =
    snapshot.shards[Math.floor(fraction * (snapshot.shards.length - 1))];
  for (const kind of [
    "frequencies",
    "positions",
    "dictionary",
    "metadata",
    "content",
  ]) {
    const key = s.generation + "/" + kind + "-0.bin";
    try {
      const r = await remote(
        "/read?" + new URLSearchParams({ key, offset: "0", length: "1" }),
      );
      await r.arrayBuffer();
      objects.push({ key, kind, size: Number(r.headers.get("x-object-size")) });
    } catch (e) {
      console.log("Probe object unavailable", key);
    }
  }
}
const rows: any[] = [],
  batches: any[] = [];
for (let round = 0; round < 3; round++)
  for (const concurrency of [1, 6, 12]) {
    const reads = [];
    for (const length of [16, 1024, 16384, 65536, 262144, 1048576])
      for (const cohort of ["repeated-range", "varied-range"])
        for (let i = 0; i < 8; i++) {
          const o =
            cohort === "repeated-range"
              ? objects[0]
              : objects[Math.floor(random() * objects.length)];
          const bytes = Math.min(length, o.size);
          reads.push({
            key: o.key,
            length: bytes,
            offset:
              cohort === "repeated-range"
                ? 0
                : Math.floor(random() * (o.size - bytes + 1)),
            kind: o.kind,
            cohort,
          });
        }
    const response: any = await (
      await remote("/latency", { reads, concurrency })
    ).json();
    const batch = batches.length;
    batches.push({
      batch,
      round,
      concurrency,
      ms: response.ms,
      colo: response.colo,
    });
    rows.push(
      ...response.rows.map((r: any) => ({
        ...r,
        batch,
        round,
        concurrency,
        colo: response.colo,
      })),
    );
    await writeFile(
      root + "/latency.json",
      JSON.stringify(
        {
          kind: "Measured Worker R2 binding; headers/body timings exclude client-to-Worker network; cache state of R2 itself is unknown",
          capturedAt: new Date().toISOString(),
          seed: 20261111,
          objects,
          batches,
          rows,
        },
        null,
        2,
      ),
    );
    console.log(
      "R2 calibration",
      round,
      concurrency,
      response.ms,
      response.colo,
    );
  }
