import json,math,statistics,pathlib
base=pathlib.Path('bench/results');records=[];summary=[]
def load(name,label):
 r=json.loads((base/(name+'.json')).read_text());records.append(r);return r,label
def row(r,label,phase):
 xs=[x for x in r['rows'] if x['phase']==phase];s=sorted(x['ms'] for x in xs)
 m=dict(label=label,delayMs=r['latencyMs'],bandwidthMiBps=r.get('bandwidthMiBps',0),phase=phase,samples=len(xs),p50=s[math.ceil(len(s)*.5)-1],p95=s[math.ceil(len(s)*.95)-1],reads=statistics.mean(x['requests'] for x in xs),bytes=statistics.mean(x['bytes'] for x in xs),cpuMs=statistics.mean(x['cpuMs'] for x in xs),zeroPct=100*statistics.mean(x['requests']==0 for x in xs));summary.append(m)
 return f"| {label} | {r['latencyMs']} | {phase} | {m['p50']:.2f} | {m['p95']:.2f} | {m['reads']:.2f} | {m['bytes']/1024:.1f} | {m['cpuMs']:.2f} | {m['zeroPct']:.1f}% |"
lines=['# Sequential paged-index optimizations on 100k Free Law Project decisions','',
'The user requested six experiments and then explicitly skipped cache-policy changes (5). The implemented sequence is 1 → 2 → 3 → 4 → 6. Each stage was measured before moving to the next; all regressions are retained.','',
'The measured default uses an 8 MiB bundle and reaches cold P50/P95 of 29/102 ms under +20 ms/read, versus 58/152 ms for the previous 1.82 MiB hybrid and 29/105 ms for the existing 48 MiB bundled baseline. This is a local simulation; differences of a few milliseconds should not be treated as a demonstrated deployed win. The 48 MiB optimized run measures 29/97 ms.','',
'Competitive positional fetching regresses this workload (stage-3 P95 186 ms versus stage-2 109 ms) and remains disabled by default. The implementation and its cumulative benchmark results are preserved rather than presenting only favorable results.','',
'## Changes','',
'1. **Hot descriptors:** bundle 10,000 descriptors ranked by frequency in the frozen 64-query training set, then corpus document frequency. Cold terms retain the complete R2 dictionary fallback.',
'2. **Budgeted streams:** use the existing joint query-completion selector to embed frequency and positional streams in remaining bundle space. The entire routing root, exact lengths, compact IDs, hot dictionary and selected payloads fit the budget.',
'3. **Competitive positions:** load frequencies, score a conservative candidate superset, then verify positional conditions in descending exact score/document-ID order. Batches are 64, then 256, then remaining candidates; stop only when later candidates cannot beat the verified heap. This experiment regressed latency and is disabled by default.',
'4. **Inline tiny streams:** cold dictionary pages include both frequency and positional payloads when their combined size is at most 128 bytes and DF is at most 256. Local offsets resolve against the dictionary page owning the descriptor.',
'5. **Skipped:** no cache admission, eviction, page alignment or in-flight read coalescing changes.',
'6. **Network-aware ranges:** evaluate one through four largest-gap partitions using estimated read waves at available concurrency plus byte-transfer time. Latency and bandwidth assumptions are configurable.','',
'## Fresh controls','',
'| Configuration | Added ms/read | Cache | P50 ms | P95 ms | Reads/query | KiB/query | CPU ms/query | Zero reads |',
'|---|---:|---|---:|---:|---:|---:|---:|---:|']
for design in ['48-mixed','hybrid-adaptive']:
 for delay in [5,20]:
  r,label=load(f'paged-opts-control-{design}-{delay}',design)
  for phase in ['cold','mixed']:lines.append(row(r,label,phase))
lines+=['','## Cumulative sequence, 8 MiB budget','',
'Competitive positional fetching stays explicitly enabled in stages 3, 4 and 6 below to isolate cumulative changes. The production-default comparison immediately afterward disables it. Other stages use normal behavior.','',
'| Configuration | Added ms/read | Cache | P50 ms | P95 ms | Reads/query | KiB/query | CPU ms/query | Zero reads |','|---|---:|---|---:|---:|---:|---:|---:|---:|']
for stage in [1,2,3,4,6]:
 for delay in [5,20]:
  r,label=load(f'paged-opts-opt{stage}-8-{delay}',f'stage {stage}')
  for phase in ['cold','mixed']:lines.append(row(r,label,phase))
lines+=['','## Measured default: all enabled changes except experimental positions','',
'| Configuration | Added ms/read | Cache | P50 ms | P95 ms | Reads/query | KiB/query | CPU ms/query | Zero reads |','|---|---:|---|---:|---:|---:|---:|---:|---:|']
for delay in [5,20]:
 r,label=load(f'paged-opts-default-opt6-8-{delay}','default 8 MiB')
 for phase in ['cold','mixed']:lines.append(row(r,label,phase))
r,label=load('paged-opts-default-opt6-8-20-bw50','default 8 MiB, 50 MiB/s')
for phase in ['cold','mixed']:lines.append(row(r,label,phase))
lines+=['','## Bundle-budget matrix, +20 ms/read','',
'The 8 MiB cases appear above. These additional runs compare embedding alone (2) and the final default (6), with experimental positional fetching off.','',
'| Configuration | Added ms/read | Cache | P50 ms | P95 ms | Reads/query | KiB/query | CPU ms/query | Zero reads |','|---|---:|---|---:|---:|---:|---:|---:|---:|']
for stage in [2,6]:
 for budget in [16,32,48]:
  r,label=load(f'paged-opts-budget-opt{stage}-{budget}-20',f'stage {stage}, {budget} MiB')
  for phase in ['cold','mixed']:lines.append(row(r,label,phase))
lines+=['','## Artifacts and startup','',
'| Stage | Budget MiB | Actual bundle MiB | Embedded stream MiB | R2 MiB | Objects |','|---|---:|---:|---:|---:|---:|']
for stage,budget in [(1,8),(2,8),(3,8),(4,8),(6,8),(2,16),(2,32),(2,48),(6,16),(6,32),(6,48)]:
 m=json.loads(pathlib.Path(f'bench/generated/flp-100000/opt{stage}-{budget}/manifest.json').read_text());lines.append(f"| {stage} | {budget} | {m['bundleBytes']/1048576:.3f} | {m['embeddedHotBytes']/1048576:.3f} | {sum(o['size'] for o in m['objects'])/1048576:.1f} | {len(m['objects'])} |")
 (base/f'paged-opts-manifest-opt{stage}-{budget}.json').write_text(json.dumps(m,indent=2)+'\n')
lines+=['','The reader shares validated immutable routing/hot-index data between query views. Startup checks validate all bundled section CRCs once. A duplicate startup validation pass was removed after initial stage measurements; raw recorded startup times therefore reflect that earlier reader where applicable. Query timers exclude startup. Node process RSS is recorded per run and is not a measurement of Worker isolate memory. Actual packaged 8/48 MiB upload sizes are in `paged-opts-bundle-8.txt` and `paged-opts-bundle-48.txt`.','',
'## Correctness and interpretation','',
f"{sum(len(r['rows']) for r in records):,} timed searches exactly matched the exhaustive reference. The reference computes exact totals before timing; tested queries request top 20 IDs/scores with totals disabled. Unit/integration tests exercise Unicode IDs, title/body fields, metadata, negative phrases, OR combinations, positional rejection of high-scoring candidates, remote/embedded/inline streams and CRC checks. No tests or benchmarks were run on a deployed Cloudflare account.",'',
'Hot descriptors remove a dependent dictionary-read phase for covered queries. Embedding selected streams provides another reduction. Inline tiny postings make a small improvement on this workload because most frequently evaluated terms already have hot descriptors. Network planning reduces requests by transferring gap bytes; the bandwidth sensitivity result is retained. Competitive positional verification saves bytes on some queries but repeatedly fetches large ranges on others, regressing this evaluation workload; it remains an explicit opt-in library/CLI option. This is not evidence that it improves production traffic.','',
'## Method and limits','',
'The corpus, tokenization, document IDs, scoring statistics and codecs are unchanged from [FLP-100K.md](FLP-100K.md). The frozen 160 evaluation strings have 40 queries each of plain, Boolean, phrase and proximity types. Embedding trains only on the separate frozen 64 training queries plus unsupervised corpus DF, never the evaluation query strings. These are artificial legal stress workloads, not representative user query logs. The observed coverage should not be assumed for production.','',
'Each process runs one design/delay configuration with a bounded 4 MiB existing LRU. Cold empties it per query; mixed uses two sequential evaluation passes and includes the initially cold pass. OS filesystem caches may be warm. Exact-result checks and RSS sampling occur outside timing. Fixed per-read delays are 5 and 20 ms, with concurrent reads overlapping. The default also has a +20 ms/read, shared FIFO 50 MiB/s per-query bandwidth sensitivity run. There is no jitter, geography, server queueing or concurrent-user model. These are local simulations, not measured R2 latencies.','',
'Root format v3 retains exact norms/IDs and a binary hot dictionary/streams; cold dictionary pages remain complete. Generation hashes include selection/packing configuration and training workload. Some stages share identical object bytes but differ in execution defaults. All objects are immutable and generation-bound. Remote copies of embedded streams are retained in packed source objects; this layout does not minimize R2 storage bytes. The v1/v2 readers and fully paged fallback remain available.','',
'Large-corpus memory guards, the cost of bundling per-document norms/IDs, and exact deep pagination remain limitations. These 100k results do not establish 10m capacity, startup CPU compliance or concurrent isolate memory safety. The experimental ranked-candidate buffer is charged to the working-set estimate.','',
'## Reproduce','',
'```sh',
'# Use fresh output directories for immutable builds.',
'node --import tsx bench/build-paged-opts.ts 1 8',
'PAGED_DESIGNS=opt1-8 PAGED_PREFIX=paged-opts PAGED_DELAYS=5,20 node --import tsx bench/paged.ts',
'# Repeat for stages 2, 3, 4, 6 in that order.',
'PAGED_DESIGNS=opt6-8 PAGED_PREFIX=paged-opts-default PAGED_COMPETITIVE=false PAGED_DELAYS=5,20 node --import tsx bench/paged.ts',
'PAGED_DESIGNS=opt6-8 PAGED_PREFIX=paged-opts-default PAGED_COMPETITIVE=false PAGED_DELAYS=20 PAGED_BANDWIDTH_MIB=50 node --import tsx bench/paged.ts',
'node --import tsx bench/paged-opts-matrix.ts',
'PAGED_DESIGNS=48-mixed,hybrid-adaptive PAGED_PREFIX=paged-opts-control PAGED_DELAYS=5,20 node --import tsx bench/paged.ts',
'PAGED_DESIGNS=opt1-8,opt2-8,opt3-8,opt4-8,opt6-8,opt6-48 PAGED_PREFIX=paged-opts node --import tsx bench/paged-worker.ts',
'python3 bench/paged-opts-report.py','```']
worker=json.loads((base/'paged-opts-workerd.json').read_text());lines.insert(lines.index('## Correctness and interpretation')+2,f'{len(worker)} actual local Worker HTTP responses were verified through Miniflare/workerd R2 bindings across the optimized layouts. IDs/order matched and scores agreed within 1e-12 across runtimes.\n')
pathlib.Path('bench/PAGED-OPTIMIZATIONS.md').write_text('\n'.join(lines)+'\n');(base/'paged-opts-summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(f'{sum(len(r["rows"]) for r in records)} timed queries; {len(worker)} Worker responses')
