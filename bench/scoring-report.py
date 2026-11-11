import json, math
from pathlib import Path
old={ (r['documents'],r['budgetMiB'],r['strategy']):r for r in json.load(open('bench/baseline-v4-scoring/results/results.json'))['results']}
new=json.load(open('bench/results/results.json'))['results']
lines=['# Scoring-loop optimization', '', 'Precompute IDF per positive term, compile scoring entries in their original order, share field length normalization across terms, and avoid allocating heap hits for rejected candidates. BM25 floating-point operation order, exact totals, tie ordering, index format, and bundle bytes are preserved.', '', 'All 24 configurations rerun: 10k/100k/1m documents × 8/16/32/48 MiB × smallest/workload. Existing indexes are byte-verified and reused; build timings and construction memory are inherited, not remeasured. These are local Node/filesystem measurements, not deployed Cloudflare latency. The small synthetic workload limits tail-latency confidence.', '', '## Matrix: plain queries', '', '|Documents|MiB|Policy|P50 before → after ms|P95 before → after ms|CPU before → after ms/query|', '|--:|--:|--|--:|--:|--:|']
for r in new:
 a=old[r['documents'],r['budgetMiB'],r['strategy']]
 lines.append(f"|{r['documents']}|{r['budgetMiB']}|{r['strategy']}|{a['p50Ms']:.2f} → {r['p50Ms']:.2f}|{a['p95Ms']:.2f} → {r['p95Ms']:.2f}|{a['avgCpuMs']:.2f} → {r['avgCpuMs']:.2f}|")
 assert all(a[k]==r[k] for k in ['bundleSha256','bundleBytes','avgRequests','avgBytes','zeroReadPercent'])
lines+=['', '## Alternating-order paired comparison', '', 'One warmup and three measured passes on identical indexes compare the frozen previous scorer to the optimized scorer. Every returned ID, score, and exact count matches. Paired timing uses the search function directly; matrix timing includes the HTTP handler.', '', '|Configuration|Suite|P50 before → after ms|P95 before → after ms|', '|--|--|--:|--:|']
for r in json.load(open('bench/results/paired-scoring.json'))['rows']:
 for kind in ['plain','connectors']:
  a=[s for s in r['samples'] if s['kind']==kind]
  def p(k,q):
   v=sorted(s[k] for s in a); return v[min(len(v)-1, math.floor(len(v)*q))]
  lines.append(f"|{r['name']}|{kind}|{p('beforeMs',.5):.2f} → {p('afterMs',.5):.2f}|{p('beforeMs',.95):.2f} → {p('afterMs',.95):.2f}|")
lines+=['', 'Bundle sizes, generations, R2 requests, and R2 bytes are unchanged in every configuration. Plain queries still read zero positional bytes. Connector samples are included in results/results.json. Local workerd HTTP measurements are in WORKERD.md; they are not Cloudflare deployment measurements.', '', 'Reproduce: `npm test`, `npm run check`, `npm run bench -- --reuse-indexes`, `node --import tsx bench/paired-scoring.ts`, `node --import tsx bench/runtime.ts`, then `python3 bench/scoring-report.py`. Reuse requires matching previously constructed indexes; omit `--reuse-indexes` to build them first.']
Path('bench/SCORING-OPTIMIZATION.md').write_text('\n'.join(lines)+'\n')
