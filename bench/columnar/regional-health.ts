import { writeFile } from "node:fs/promises";
import { benchmarkToken } from "./token.js";
const token = await benchmarkToken(),
  rows = [];
for (const name of [
  "work-search-cws-client-west",
  "work-search-cws-client-eu",
]) {
  const r = await fetch(`https://${name}.phulin.workers.dev/health`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    body = (await r.json()) as any;
  const row = {
    name,
    status: r.status,
    placement: r.headers.get("cf-placement"),
    requestColo: body.requestColo,
    egressColo: body.egressTrace?.colo,
    country: body.egressTrace?.loc,
  };
  rows.push(row);
  console.log(row);
}
await writeFile(
  "work/columnar-bench/regional-health.json",
  JSON.stringify({ at: new Date().toISOString(), rows }, null, 2),
);
