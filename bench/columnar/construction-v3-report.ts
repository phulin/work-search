import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename } from "node:path";

const [out, ...directories] = process.argv.slice(2);
if (!out || !directories.length)
  throw Error("Use OUTPUT_DIRECTORY BUILD_DIRECTORY...");
await mkdir(out, { recursive: true });
for (const directory of directories) {
  const manifest = JSON.parse(
    await readFile(directory + "/manifest.json", "utf8"),
  );
  const completed = await readFile(directory + "/completed.json", "utf8").then(
    JSON.parse,
    () => undefined,
  );
  const rows = (await readFile(directory + "/requests.jsonl", "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const paths = [...new Set<string>(rows.map((r) => r.path))];
  function summarize(selected: any[]) {
    const operations: Record<string, number> = {},
      failures: Record<string, number> = {};
    let bytesRead = 0,
      bytesWritten = 0,
      workerWallMs = 0,
      clientMs = 0,
      decodedBytes = 0,
      continuationDecodeBytes = 0;
    let downloadedBytes = 0,
      uploadedBytes = 0;
    for (const row of selected) {
      const t = row.telemetry;
      for (const [key, n] of Object.entries(t?.io?.operations ?? t?.r2 ?? {}))
        operations[key] = (operations[key] ?? 0) + Number(n);
      for (const [key, n] of Object.entries(t?.io?.failures ?? {}))
        failures[key] = (failures[key] ?? 0) + Number(n);
      bytesRead += t?.io?.bytesRead ?? 0;
      bytesWritten += t?.io?.bytesWritten ?? 0;
      workerWallMs += t?.wallMs ?? 0;
      clientMs += row.clientMs ?? 0;
      decodedBytes += t?.codec?.decodedBytes ?? 0;
      continuationDecodeBytes += t?.codec?.continuationDecodeBytes ?? 0;
      downloadedBytes += row.downloadedBytes ?? 0;
      uploadedBytes += row.uploadedBytes ?? 0;
    }
    return {
      attempts: selected.length,
      successes: selected.filter(
        (r) => r.status === undefined || r.status === 200,
      ).length,
      busy: selected.filter((r) => r.status === 503).length,
      errors: selected.filter(
        (r) =>
          (r.status && r.status !== 200 && r.status !== 503) ||
          r.transportFailure,
      ).length,
      reused: selected.filter((r) => r.reused).length,
      operations,
      failures,
      bytesRead,
      bytesWritten,
      workerWallMs,
      clientMs,
      decodedBytes,
      continuationDecodeBytes,
      coordinator: { downloadedBytes, uploadedBytes },
    };
  }
  const first = manifest.startedAt,
    last = completed?.finishedAt ?? manifest.finishedAt;
  const report = {
    directory,
    manifest,
    completed,
    elapsedMs: first && last ? Date.parse(last) - Date.parse(first) : undefined,
    complete: !!last,
    totals: summarize(rows),
    phases: paths.map((path) => ({
      path,
      ...summarize(rows.filter((r) => r.path === path)),
    })),
    limitations: [
      "Summed request durations overlap and are not end-to-end elapsed time.",
      "Counters include logged failed attempts and current receipt-reuse costs; original work is never added again.",
      "Worker CPU requires Cloudflare observations; codec timers from performance.now are not CPU measurements.",
      "The replacement logs coordinator upload/download traffic separately. Legacy controls omit some coordinator transfers and publication helper operations; their operation totals are lower bounds.",
      "Native memory peaks and cumulative allocations are not supplied by these request counters.",
    ],
  };
  await writeFile(
    out + "/" + basename(directory) + ".json",
    JSON.stringify(report, null, 2),
  );
  console.log(basename(directory), JSON.stringify(report.totals));
}
