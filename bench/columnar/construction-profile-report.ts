import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
for (const path of process.argv.slice(2)) {
  const profile = JSON.parse(gunzipSync(await readFile(path)).toString());
  const nodes = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]));
  const counts = new Map<string, number>();
  for (const [i, id] of profile.samples.entries()) {
    const node = nodes.get(id),
      f = node?.callFrame;
    const key = [
      f?.functionName || "(anonymous)",
      f?.url?.split("/").slice(-2).join("/"),
      (f?.lineNumber ?? -1) + 1,
    ].join(":");
    counts.set(key, (counts.get(key) ?? 0) + (profile.timeDeltas?.[i] ?? 1));
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  console.log(path, "sampled time", total);
  console.table(
    [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([frame, time]) => ({
        frame,
        percent: +((time * 100) / total).toFixed(1),
      })),
  );
}
