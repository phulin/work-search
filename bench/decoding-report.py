import json,math
from pathlib import Path
old={ (r['documents'],r['budgetMiB'],r['strategy']):r for r in json.load(open('bench/baseline-v5-blocks/results/results.json'))['results']}
new=json.load(open('bench/results/results.json'))['results']
def pct(values,q):
 v=sorted(values);return v[math.ceil(len(v)*q)-1]
lines=['# V5 block-decoder optimization', '', 'Index format, generation hashes, embedded bytes and configured budgets are unchanged. Full scans bypass sparse planning/scheduling; frequencies and absolute positional offsets decode directly into final arrays. Directory fields use scalar reads instead of temporary arrays. One-byte varints have an immediate fast path. Indexed checksum loops retain per-block CRCs. Selected blocks still validate canonical varints, sorted IDs/positions, stream binding, exact boundaries and trailing data. No posting cache or expanded index tables are added.', '', '## Full 24-configuration matrix', '', '10k/100k/1m documents × 8/16/32/48 MiB × smallest/workload. Twelve plain and seven connector queries, three passes each, top 20, IDs only, seed 42. Existing v5 indexes are byte-verified and reused. Construction time/RSS is inherited from the prior matching build, not remeasured. These are local Node HTTP/filesystem measurements, not deployed Cloudflare latency; small synthetic query sets limit tail confidence.', '', '|Docs|MiB|Policy|Plain P95 ms before → after|Connector P95 ms before → after|CPU ms/query before → after|', '|--:|--:|--|--:|--:|--:|']
for r in new:
 a=old[r['documents'],r['budgetMiB'],r['strategy']]
 assert r['status']=='ok' and r['bundleBytes']<=r['budget']
 for key in ['bundleSha256','bundleBytes','generation','budget','avgRequests','avgBytes','zeroReadPercent']:
  assert a[key]==r[key],key
 for suite in ['samples','connectorSamples']: assert all(not s.get('error') for s in r[suite])
 assert all(s['positionRequests']==s['positionBytes']==0 for s in r['samples'])
 c0=pct([s['ms'] for s in a['connectorSamples']],.95); c1=pct([s['ms'] for s in r['connectorSamples']],.95)
 lines.append(f"|{r['documents']}|{r['budgetMiB']}|{r['strategy']}|{a['p95Ms']:.2f} → {r['p95Ms']:.2f}|{c0:.2f} → {c1:.2f}|{a['avgCpuMs']:.2f} → {r['avgCpuMs']:.2f}|")
for file,title in [('paired-block-decoding','Paired previous v5 → optimized v5 (identical index bytes)'),('paired-v4-decoding','Paired pre-block v4 → optimized v5 (regression recovery)')]:
 lines+=['', '## '+title, '', 'One warmup, three alternating-order measured passes, same-process search calls. All IDs, exact scores and match counts must agree. The v5 comparison freezes the previous loader, directory parser, codecs and scorer; query parsing/positional evaluation are shared. The v4 comparison uses preserved v4 generations and the frozen v4 scorer/reader with the frozen pre-optimization codec. Local filesystem I/O, not Cloudflare network latency.', '', '|Configuration|Suite|P50 ms before → after|P95 ms before → after|', '|--|--|--:|--:|']
 for r in json.load(open('bench/results/'+file+'.json'))['rows']:
  for kind in ['plain','connectors','selective']:
   a=[s for s in r['samples'] if s['kind']==kind]
   def p(k,q):return pct([s[k] for s in a],q)
   lines.append(f"|{r['name']}|{kind}|{p('beforeMs',.5):.2f} → {p('afterMs',.5):.2f}|{p('beforeMs',.95):.2f} → {p('afterMs',.95):.2f}|")
lines+=['', '## Decoder-only measurements', '', 'Preloaded encoded bytes eliminate filesystem/network reads and isolate full-list decoding. One warmup, five alternating-order measured passes. Indexed CRC loops and removal of temporary block structures are included; ranking and positional matching are excluded.', '', '|Term|Positions|Median ms before → after|', '|--|--|--:|']
x=json.load(open('bench/results/block-decoder-profile.json'))['samples']
for term in dict.fromkeys(s['term'] for s in x):
 for pos in [False,True]:
  a=[s for s in x if s['term']==term and s['positions']==pos]
  lines.append(f"|{term}|{pos}|{pct([s['before']['ms'] for s in a],.5):.2f} → {pct([s['after']['ms'] for s in a],.5):.2f}|")
lines+=['', 'All 24 bundle hashes, sizes, generation IDs and plain-query I/O metrics match the previous v5 run. Actual local workerd results and startup wall measurements are in WORKERD.md; they do not measure Cloudflare account startup CPU or deployed R2 latency. Raw CPU, memory, per-query diagnostics and failures are in results/results.json. No Cloudflare deployment is claimed.', '', 'Reproduce: `npm run check`, `npm test`, `npm run bench -- --reuse-indexes`, `node --import tsx bench/profile-block-decoding.ts`, `node --import tsx bench/paired-block-decoding.ts`, `node --import tsx bench/paired-v4-decoding.ts`, `node --import tsx bench/runtime.ts`, and `python3 bench/decoding-report.py`. Reuse requires matching existing construction records; omit --reuse-indexes to construct indexes. The optional pre-block recovery comparison also needs the preserved v4 corpora/indexes described in BLOCK-POSTINGS.md.', '', 'Limitations: broad queries still decode and score exhaustively; sparse remote plans can add prefix reads and transfer gap bytes; the working-set guard remains conservative. This change does not alter those tradeoffs or add score-bound pruning.']
Path('bench/BLOCK-DECODING.md').write_text('\n'.join(lines)+'\n')
