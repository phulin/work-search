import json, math
from pathlib import Path
baseline={ (r['documents'],r['budgetMiB'],r['strategy']):r for r in json.load(open('bench/baseline-v4-blocks/results/results.json'))['results']}
rows=json.load(open('bench/results/results.json'))['results']
lines=['# Block postings and skip pointers (v4 → v5)', '', 'Large lists restart every 256 documents. A checksummed skip directory supplies document boundaries, offsets, lengths and frequency/position CRCs. Small lists (at most 256 documents) keep the compact split-stream codecs. A required rare term can anchor Boolean, phrase and proximity queries; matching candidates seek relevant blocks in longer lists. Fragmented selections use at most four range windows per stream, decoding only selected blocks inside them. All query reads share concurrency four.', '', 'Every directory and embedded payload byte counts against the unchanged 8/16/32/48 MiB budget. Dictionaries and compressed document tables retain their v4 layouts. Remote sparse plans add a directory-prefix request and an anchor phase; broad queries and scattered matches can gain little or regress. Full scans use one range per stream. Exact totals, ranking and tie order are retained. Full generation rebuild required; v4 bundles are rejected by v5.', '', '## Full matrix', '', '24 freshly rebuilt configurations: seed 42, 10k/100k/1m documents, two embedding policies, four budgets. Twelve plain and seven connector queries, three passes each, top 20, IDs only. Local Node HTTP handler/filesystem measurements; not deployed Cloudflare/R2 latency. Construction records are in results/block-builds.json. The final query matrix reuses byte-verified indexes; build times/RSS are inherited from those fresh builds, and query timings/RSS are remeasured with the final code. Small query counts limit tail-latency confidence.', '', '|Docs|MiB|Policy|Plain P95 ms before → after|Connector P95 ms before → after|Plain zero reads % before → after|Plain reads/query before → after|', '|--:|--:|--|--:|--:|--:|--:|']
def pct(values,q):
 v=sorted(values);return v[math.ceil(len(v)*q)-1]
for r in rows:
 if r.get('status')!='ok': raise RuntimeError(str(r))
 a=baseline[r['documents'],r['budgetMiB'],r['strategy']]
 assert r['bundleBytes']<=r['budget'] and r['format']==5
 for suite in ['samples','connectorSamples']:
  assert all(not s.get('error') for s in r[suite])
 assert all(s['positionRequests']==s['positionBytes']==0 for s in r['samples'])
 c0=pct([s['ms'] for s in a['connectorSamples']],.95);c1=pct([s['ms'] for s in r['connectorSamples']],.95)
 lines.append(f"|{r['documents']}|{r['budgetMiB']}|{r['strategy']}|{a['p95Ms']:.2f} → {r['p95Ms']:.2f}|{c0:.2f} → {c1:.2f}|{a['zeroReadPercent']:.1f} → {r['zeroReadPercent']:.1f}|{a['avgRequests']:.2f} → {r['avgRequests']:.2f}|")
lines+=['', '## Alternating-order cross-format comparison', '', 'Preserved v4 indexes and the optimized v4 engine are compared to freshly built v5 indexes for identical ordered corpora. One warmup, three alternating-order measured passes. Every query must return identical IDs, exact scores and totals. The additional selective suite uses rare/common conjunctions, phrases and proximity queries and is reported separately from the original workload.', '', '|Configuration|Suite|P50 ms before → after|P95 ms before → after|Mean reads before → after|Mean bytes before → after|', '|--|--|--:|--:|--:|--:|']
for r in json.load(open('bench/results/paired-blocks.json'))['rows']:
 for kind in ['plain','connectors','selective']:
  samples=[s for s in r['samples'] if s['kind']==kind]
  def p(k,q):return pct([s[k] for s in samples],q)
  def mean(k):return sum(s[k] for s in samples)/len(samples)
  lines.append(f"|{r['name']}|{kind}|{p('beforeMs',.5):.2f} → {p('afterMs',.5):.2f}|{p('beforeMs',.95):.2f} → {p('afterMs',.95):.2f}|{mean('beforeRequests'):.2f} → {mean('afterRequests'):.2f}|{mean('beforeBytes'):.0f} → {mean('afterBytes'):.0f}|")
lines+=['', 'At one million documents / 48 MiB, the paired selective suite reduces P50 by about 73% and P95 by about 37%. This is not a universal speedup: paired original plain P95 rises about 10%, and connector P95 about 7%. The synthetic rare-term hits are scattered, so coalesced positional reads transfer nearly whole lists; CPU decoding improves more than remote bytes. R2 request counts may increase for sparse remote plans. These local results do not predict production network latency.', '', '### Selective query details (million documents / 48 MiB)', '', '|Query|P50 ms before → after|Mean bytes before → after|', '|--|--:|--:|']
r=next(r for r in json.load(open('bench/results/paired-blocks.json'))['rows'] if r['name']=='1000000-48-workload')
for q in dict.fromkeys(s['q'] for s in r['samples'] if s['kind']=='selective'):
 a=[s for s in r['samples'] if s['q']==q]
 lines.append(f"|`{q}`|{pct([s['beforeMs'] for s in a],.5):.2f} → {pct([s['afterMs'] for s in a],.5):.2f}|{sum(s['beforeBytes'] for s in a)/len(a):.0f} → {sum(s['afterBytes'] for s in a)/len(a):.0f}|")
lines+=['', '## Size and resource tradeoffs', '', '|Docs (48 MiB workload)|Frequency bytes before → after|Position bytes before → after|Bundle bytes before → after|', '|--:|--:|--:|--:|']
for r in rows:
 if r['budgetMiB']==48 and r['strategy']=='workload':
  a=baseline[r['documents'],48,'workload']
  lines.append(f"|{r['documents']}|{a['frequencyBytes']} → {r['frequencyBytes']}|{a['positionBytes']} → {r['positionBytes']}|{a['bundleBytes']} → {r['bundleBytes']}|")
lines+=['', 'Build throughput, process peak RSS, query CPU and complete per-query diagnostics are recorded in results/results.json; construction RSS is not Worker isolate memory. Local actual-workerd startup/HTTP measurements are in WORKERD.md. No Cloudflare account deployment was performed.', '', 'Reproduce with `npm run check`, `npm test`, `npm run bench`, `node --import tsx bench/paired-blocks.ts`, `node --import tsx bench/runtime.ts`, then `python3 bench/blocks-report.py`. The paired run needs preserved v4 indexes at bench/generated/v4-100000-8-workload and v4-1000000-48-workload, built from the same seeded corpora at commit 1d4ba24. Frozen v4 engine/index readers are in baseline-v4-blocks/. Earlier paired scripts require their historical format generations.', '', 'Highest-value follow-ups: choose remote range windows using read/byte cost estimates, candidate-directed positions after full coarse evaluation, richer Boolean candidate plans, joint frequency/position embedding, and score-bound pruning for broad queries. The current working-set guard conservatively uses complete term sizes, so very large terms may still be rejected even if a sparse plan could fit.']
Path('bench/BLOCK-POSTINGS.md').write_text('\n'.join(lines)+'\n')
