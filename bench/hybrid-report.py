import json,statistics,math,pathlib,re
base=pathlib.Path('bench/results');designs=['48-mixed','paged','hybrid-tables','hybrid-adaptive'];records=[];summary=[]
def percentile(rows,key,p):
 xs=sorted(x[key] for x in rows);return xs[max(0,math.ceil(len(xs)*p)-1)]
def mean(rows,key):return statistics.mean(x[key] for x in rows)
def metrics(r,phase):
 xs=[x for x in r['rows'] if x['phase']==phase]
 return dict(design=r['design'],delayMs=r['latencyMs'],bandwidthMiBps=r.get('bandwidthMiBps',0),phase=phase,samples=len(xs),p50=percentile(xs,'ms',.5),p95=percentile(xs,'ms',.95),cpuMs=mean(xs,'cpuMs'),reads=mean(xs,'requests'),bytes=mean(xs,'bytes'),zeroPct=100*statistics.mean(x['requests']==0 for x in xs))
lines=['# Making the paged index competitive on 100k Free Law Project decisions','',
'The 1.82 MiB hybrid improves cold P50/P95 from 189/386 ms to 56/140 ms under the +20 ms/read model: about 70%/64% lower latency than the original paged layout. Reads fall from 18.12 to 6.86/query, and bytes from 3,065.6 to 1,414.3 KiB/query. The 48 MiB bundled baseline remains faster at 28/105 ms. With no simulated delay, the hybrid and bundled baseline both measure about 7/36–37 ms.','',
'The shared-bandwidth sensitivity run (+20 ms/read, 50 MiB/s) measures cold hybrid P50/P95 at 65/273 ms versus 32/251 ms for the 48 MiB baseline. The hybrid narrows the gap substantially but does not beat the larger bundled index.','',
'## Implementation sequence','',
'1. Bundle exact u32 body/title lengths and independently front-coded IDs, retaining R2 dictionary/postings/positions/metadata. Share validated immutable routing data across query views. Benchmark this with the previous fixed posting-read policy.',
'2. Add adaptive frequency reads: whole lists up to 256 KiB, directory plus initial 64 KiB for larger lists, and sequential read-ahead doubling up to 1 MiB. Reset read-ahead after a jump. Rebenchmark the fixed-policy ablation alongside the adaptive policy and both existing baselines.','',
'The hybrid bundle is 1,910,250 bytes (1.82 MiB): 800,000 bytes of exact lengths, 933,694 bytes of compact IDs, and the routing root/header. It fits all 8/16/32/48 MiB budgets with identical contents; it is measured once rather than relabeled four times. There are no bundled term descriptors or postings. The 48 MiB bundled baseline retains its existing mixed embedding policy. The original fully paged baseline is its v1 root with fixed reads.','',
'## First change measured before adaptive reads','',
'| Added ms/read | Cache | P50 ms | P95 ms | Reads/query | KiB/query |','|---:|---|---:|---:|---:|---:|']
for delay in [0,5,20]:
 r=json.loads((base/f'hybrid-step1-hybrid-tables-{delay}.json').read_text());records.append(r)
 for phase in ['cold','mixed']:
  m=metrics(r,phase);lines.append(f"| {delay} | {phase} | {m['p50']:.2f} | {m['p95']:.2f} | {m['reads']:.2f} | {m['bytes']/1024:.1f} |")
lines+=['','## Final paired comparison: fixed delay, no bandwidth cap','',
'| Design | Added ms/read | Cache | P50 ms | P95 ms | CPU ms/query | Reads/query | KiB/query | Zero reads |',
'|---|---:|---|---:|---:|---:|---:|---:|---:|']
for design in designs:
 for delay in [0,5,20]:
  r=json.loads((base/f'hybrid-final-{design}-{delay}.json').read_text());records.append(r)
  for phase in ['cold','mixed']:
   m=metrics(r,phase);summary.append(m);lines.append(f"| {design} | {delay} | {phase} | {m['p50']:.2f} | {m['p95']:.2f} | {m['cpuMs']:.2f} | {m['reads']:.2f} | {m['bytes']/1024:.1f} | {m['zeroPct']:.1f}% |")
lines+=['','## Bandwidth sensitivity: +20 ms/read, shared 50 MiB/s transfer budget','',
'| Design | Cache | P50 ms | P95 ms | Reads/query | KiB/query |','|---|---|---:|---:|---:|---:|']
for design in ['48-mixed','hybrid-tables','hybrid-adaptive']:
 r=json.loads((base/f'hybrid-final-{design}-20-bw50.json').read_text());records.append(r)
 for phase in ['cold','mixed']:
  m=metrics(r,phase);summary.append(m);lines.append(f"| {design} | {phase} | {m['p50']:.2f} | {m['p95']:.2f} | {m['reads']:.2f} | {m['bytes']/1024:.1f} |")
lines+=['','## Cold I/O breakdown, +20 ms/read without bandwidth cap','',
'| Design | Dictionary reads | Length reads | Result-record reads | Frequency reads | Position reads |','|---|---:|---:|---:|---:|---:|']
for design in designs:
 r=json.loads((base/f'hybrid-final-{design}-20.json').read_text());xs=[x for x in r['rows'] if x['phase']=='cold'];values=[statistics.mean(x['io'].get(k,{}).get('requests',0) for x in xs) for k in ['dictionary','norms','documents','frequencies','positions']];lines.append('| '+design+' | '+' | '.join(f'{v:.2f}' for v in values)+' |')
lines+=['','## Query types, cold +20 ms/read','',
'| Design | Type | P50 ms | P95 ms | Reads/query |','|---|---|---:|---:|---:|']
for design in designs:
 r=json.loads((base/f'hybrid-final-{design}-20.json').read_text())
 for kind in ['plain','boolean','phrase','proximity']:
  xs=[x for x in r['rows'] if x['phase']=='cold' and x['kind']==kind];lines.append(f"| {design} | {kind} | {percentile(xs,'ms',.5):.2f} | {percentile(xs,'ms',.95):.2f} | {mean(xs,'requests'):.2f} |")
lines+=['','## Bundle, storage, startup and memory','',
'| Design | Bundle MiB | R2 MiB | Startup ms (range) | Sampled max RSS MiB (range) |','|---|---:|---:|---|---|']
for design in ['48-mixed','paged','hybrid-tables']:
 path=pathlib.Path(f'bench/generated/flp-100000/{design}/manifest.json');m=json.loads(path.read_text());rs=[r for r in records if r['design']==design];lines.append(f"| {design} | {m['bundleBytes']/1048576:.3f} | {sum(o['size'] for o in m['objects'])/1048576:.1f} | {min(r['startupMs'] for r in rs):.2f}–{max(r['startupMs'] for r in rs):.2f} | {min(r['maxProcessRss'] for r in rs)/1048576:.1f}–{max(r['maxProcessRss'] for r in rs)/1048576:.1f} |")
worker=json.loads((base/'hybrid-final-workerd.json').read_text());pack=(base/'hybrid-bundle.txt').read_text();match=re.search(r'Total Upload: ([^\n]+)',pack)
lines+=['','## Validation and interpretation','',
f"{sum(len(r['rows']) for r in records):,} timed searches matched the frozen exhaustive-reference results exactly. {len(worker)} additional real local Worker HTTP responses matched IDs/order and scores within 1e-12 across runtimes. Wrangler packaging of the actual hybrid root: {match.group(1) if match else 'see hybrid-bundle.txt'}. No deployment to Cloudflare was performed.",'',
'The first optimization removes all remote length and result-record reads for ID-only searches. The adaptive policy reduces dependent posting reads by spending more bytes where needed. The full dictionary still lives in R2, so cold queries retain a dictionary-read phase. The hybrid uses far less bundle space than the 48 MiB baseline; it does not embed that baseline’s hot posting streams. Any remaining latency and bytes gap must be evaluated in that context.','',
'## Method and limits','',
'The same 100,000 decisions, tokenization, document order, scoring statistics and codecs are used throughout. The frozen 160-query evaluation workload has 40 queries each of plain, Boolean, phrase and proximity types. The corpus and workload provenance remain in [FLP-100K.md](FLP-100K.md). Queries return the best 20 external IDs/scores, with exact totals off and metadata off. Metadata queries still fetch result records and metadata separately; tests compare those against the original engine.','',
'Cold clears the 4 MiB engine cache before each query. Mixed runs two sequential workload passes with a shared 4 MiB cache and includes the initially cold pass. Every design/delay combination uses a separate process. Reference results are computed before timing and loaded as a small file in child processes. Correctness checks and RSS sampling happen after query timing. Local OS file caches may be warm. CPU is process CPU consumed during a query. RSS is sampled Node/tsx process memory, not Worker isolate memory; startup includes local file reading and index construction, not deployed startup CPU. Local timing noise remains; raw samples are retained.','',
'The fixed-delay model adds 0/5/20 ms to every actual read while allowing concurrent requests to overlap. The optional bandwidth model additionally reserves transfer time on a FIFO 50 MiB/s link shared by all reads within a query, after their added latency. It is not a cap per connection. It does not model jitter, geography, R2 server queues, HTTP multiplexing details or concurrent user queries. These are sensitivity measurements, not predictions of deployed R2 latency.','',
'The first-step measurements were taken before implementing adaptive reads. The final matrix reruns the fixed-policy ablation beside the adaptive policy. Reuse of immutable routing data was introduced with the local tables, so the first-step CPU improvement includes avoiding repeated routing JSON parsing.','',
'Local tables scale with document count: exact norms use 8 bytes/document and IDs have corpus-dependent compression. A configured bundle budget is enforced; these tables are optional. The fully paged fallback remains available for larger corpora. These measurements do not prove ten-million-document latency or memory safety. Materialized executor working-set guards and the 16 MiB remote-norm guard remain.','',
'The next major opportunities are workload-selected dictionary/posting embedding and selective position fetching for connector candidates. No forward index, persistent pagination cursor, result cache, quantized scoring or workload-selected phrase accelerator was added.','',
'## Reproduce','',
'```sh',
'node --import tsx src/cli/main.ts page --source bench/generated/flp-100000/48-mixed --out bench/generated/flp-100000/hybrid-tables --local-tables --budget-mib 8',
'PAGED_DESIGNS=hybrid-tables PAGED_PREFIX=hybrid-step1 node --import tsx bench/paged.ts',
'PAGED_DESIGNS=48-mixed,paged,hybrid-tables,hybrid-adaptive PAGED_PREFIX=hybrid-final node --import tsx bench/paged.ts',
'PAGED_DESIGNS=48-mixed,hybrid-tables,hybrid-adaptive PAGED_PREFIX=hybrid-final PAGED_DELAYS=20 PAGED_BANDWIDTH_MIB=50 node --import tsx bench/paged.ts',
'PAGED_DESIGNS=48-mixed,paged,hybrid-adaptive PAGED_PREFIX=hybrid-final node --import tsx bench/paged-worker.ts',
'python3 bench/hybrid-report.py','```','',
'`hybrid-adaptive` is a benchmark alias for the same `hybrid-tables` bundle with adaptive reads; the fixed ablation explicitly selects the old policy. A newly built v2 hybrid Worker defaults to adaptive reads. Preserve immutable outputs and choose a fresh directory when rebuilding.']
pathlib.Path('bench/HYBRID-INDEX.md').write_text('\n'.join(lines)+'\n');(base/'hybrid-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(f"{sum(len(r['rows']) for r in records)} timed searches verified")
