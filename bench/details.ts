import { readFile, writeFile } from "node:fs/promises";
const { results } = JSON.parse(
  await readFile("bench/results/results.json", "utf8"),
);
let report =
  "# Resource and cost detail\n\nThese use the same measured builds as REPORT.md. Binary-view construction is a warm Node microbenchmark; it excludes disk reads, process startup, and module evaluation. RSS is the peak for the entire offline build/query child process, **not Worker isolate memory**. Worker memory was not measured on Cloudflare.\n\n|Docs|Budget MiB|Policy|Dictionary KiB|Document table MiB|Uncompressed table MiB|Postings MiB|Embedded MiB|Remote objects MiB|View construction ms|Build peak RSS MiB|R2 storage/month USD|R2 reads/1M queries USD|\n|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n";
for (const r of results.filter((r: any) => r.status === "ok")) {
  const remote = r.objects.reduce((s: number, o: any) => s + o.size, 0);
  report += `|${r.documents}|${r.budgetMiB}|${r.strategy}|${(r.dictionaryBytes / 1024).toFixed(1)}|${(r.documentTableBytes / 1048576).toFixed(2)}|${(r.documentTableUncompressedBytes / 1048576).toFixed(2)}|${(r.postingsBytes / 1048576).toFixed(2)}|${(r.embeddedBytes / 1048576).toFixed(2)}|${(remote / 1048576).toFixed(2)}|${r.constructorMs.toFixed(4)}|${(r.peakRssBytes / 1048576).toFixed(1)}|${((remote / 1e9) * 0.015).toFixed(5)}|${(r.avgRequests * 0.36).toFixed(3)}|\n`;
}
report +=
  "\nCost estimates exclude free tiers, Workers request/CPU charges, metadata-query reads, retries, and build/deployment operations. R2 objects include packed metadata even though the measured searches request only IDs. One full reupload costs object count / 1e6 × $4.50 in Class A writes, plus HEAD reads; repeat verified uploads skip PUTs. These small storage estimates do not mean total hosting is free: Workers Paid has a $5 monthly minimum and CPU usage matters for common terms. Pricing sources: [R2](https://developers.cloudflare.com/r2/pricing/), [Workers](https://developers.cloudflare.com/workers/platform/pricing/).\n\nThis is an initial synthetic baseline: twelve fixed query types, three passes per configuration, one deterministic corpus seed, no real-world corpus supplied. Tail percentiles have limited statistical confidence. Workload-aware selection uses the test queries as training input; validate generalization with independent traffic before choosing a production policy. No measured query failures occurred.\n";
await writeFile("bench/RESOURCES.md", report);
