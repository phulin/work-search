import json,struct,pathlib,statistics,math
root=pathlib.Path('bench'); out=[]
def read(name):return json.loads((root/'results'/name).read_text())
def table(headers,rows):
 return '|'+ '|'.join(headers)+'|\n|'+'|'.join(['---']*len(headers))+'|\n'+''.join('|'+ '|'.join(str(x) for x in row)+'|\n' for row in rows)
def f(n):return f'{n:.2f}'
labels=['Baseline','1. Scoring seeks','2. Score before positions','3. Adaptive bounds','4. Persisted bounds / block cursors','5. Adaptive position seeks','6. Block/directory/range cache','7. Packed/constant columns']
out.append('# Seven sequential optimization experiments\n')
out.append('All measurements are local, on the same synthetic corpus; none are deployed Cloudflare/R2 latency. Budgets remain 8/16/32/48 MiB. No workload-selected phrase accelerators were implemented.\n')
out.append('## Method\nEight separate cumulative runs: baseline plus each change, in the requested order. Each run covers one million documents, four budgets, 12 plain and seven connector queries, top 20, default total=false, one empty-runtime-cache pass then three repeated passes per query. These are 304 timed searches per stage (2,432 total), each checked against exact IDs and scores from the frozen exhaustive v5 engine on the original index. Cold means the application cache is empty; OS caches and document validation may already be warm. Warm repeats deliberately assume locality. Small samples and fixed stage order make small differences noisy; these are observations, not confidence intervals.\n')
out.append('The final matrix adds 10k/100k/1m documents × four budgets × frequency-first/joint embedding, with both policies trained on the same mixed workload. It is not a held-out policy experiment. Each final configuration has 76 searches, 1,824 total. Conversion/repacking timings are not ingestion throughput. The original v6 million-document corpus build took 78.93 seconds; later stages convert encoded streams offline. Final Worker tests use real local workerd with Miniflare R2, not public HTTP storage.\n')
for cold in [False,True]:
 rows=[]
 for stage,label in enumerate(labels):
  summary=read(f'next-{stage}.json')['summary']; a=[r for r in summary if r['budget']==48 and r['cold']==cold]
  plain=next(r for r in a if r['kind']=='plain');conn=next(r for r in a if r['kind']=='connector')
  rows.append([label,f(plain['p50']),f(plain['p95']),f(conn['p50']),f(conn['p95'])])
 out.append('## Million documents, 48 MiB: '+('cache-cold' if cold else 'cache-warm')+'\n')
 out.append(table(['Cumulative stage','Plain P50 ms','Plain P95 ms','Connector P50 ms','Connector P95 ms'],rows))
out.append('## Interpretation\nThe clearest gain is cold broad plain-query execution from persisted bounds and block cursors. Warm connector median improves overall, while its tail is essentially flat. Some individual stages regress latency; the table retains those outcomes. Scoring seeks alone are not a statistically established improvement on this small suite. Cheap plain-query warm medians regress slightly in absolute terms, despite improved cold tail latency.\n')
out.append('Initial always-on position seeks and generic packed decoding regressed: see next-5-initial.json through next-7-initial.json. The final encoder reserves seek tables for blocks averaging over four positions per row, retains legacy sparse positions, and uses native fills/arithmetic runs for constant frequency/document-gap columns. Caching excludes oversized local scans; remote cache misses retain one full frequency read to avoid many small requests.\n')
dense=read('next-dense.json')
a=[s['ms'] for s in dense['samples'] if s['stage']==4 and s['pass']>0]
b=[s['ms'] for s in dense['samples'] if s['stage']==5 and s['pass']>0]
out.append(f"## Dense positional workload\nA separate 32,768-document corpus repeats three terms 64 times per document (192 positions). Three phrase/proximity queries run five passes with alternating variant order and exact result equality. After the first pass, legacy positional median is {statistics.median(a):.2f} ms versus {statistics.median(b):.2f} ms with seek tables. Both use identical frequency encoding and an 8 MiB budget. This targets the dense case selected by the adaptive encoder; raw samples are in results/next-dense.json.\n")
out.append('## Final matrix\n')
rows=[]
for d in read('next-matrix.json')['results']:
 for budget in [8,16,32,48]:
  samples=[s for s in d['samples'] if s['budget']==budget]
  warm=[s['ms'] for s in samples if s['pass']>0];warm.sort()
  rows.append([d['n'],budget,d['policy'],f(sum(s['indexRequests']==0 for s in samples)*100/len(samples)),f(statistics.mean(s['indexRequests'] for s in samples)),round(statistics.mean(s['indexBytes'] for s in samples)),f(statistics.median(warm)),f(warm[math.ceil(.95*len(warm))-1])])
out.append(table(['Docs','MiB','Policy','Zero reads %','Reads/query','Bytes/query','Warm P50 ms','Warm P95 ms'],rows))
storage=[]
for n in [10000,100000,1000000]:
 for budget in [8,16,32,48]:
  for policy in ['frequency','mixed']:
   path=root/'generated'/f'matrix-{n}-{budget}-{policy}'
   b=(path/'bundle.bin').read_bytes();m=json.loads((path/'manifest.json').read_text());count=struct.unpack_from('<I',b,16)[0];freq=pos=0
   for i in range(count):freq+=struct.unpack_from('<I',b,128+i*40+16)[0];pos+=struct.unpack_from('<I',b,128+i*40+32)[0]
   d={'docs':n,'budgetMiB':budget,'policy':policy,'bundleBytes':len(b),'frequencyBytes':freq,'positionBytes':pos,'dictionaryBytes':struct.unpack_from('<I',b,48)[0],'totalStoredBytes':len(b)+sum(o['size'] for o in m['objects'])}
   assert len(b)<=budget*1048576;storage.append(d)
(root/'results'/'next-storage.json').write_text(json.dumps(storage,indent=2))
out.append('## Storage, memory and runtime\nMillion-document frequency postings shrink from 165,910,369 to 79,438,940 bytes (52.1%); positional bytes stay 48,104,449. The 48 MiB Wrangler dry run passes: 49,235.71 KiB total upload / 35,619.18 KiB gzip. This is a local packaging check, not deployed account validation. All 24 final bundles fit their budgets. Exact dictionary, frequency, positional, bundle and total stored bytes are in results/next-storage.json. Per-query CPU, request/byte counts, RSS and heap observations are in the stage/matrix JSON. Peak RSS is a Node benchmark-process observation, including oracle/index fixtures and OS allocator retention; it is not Worker isolate memory. Cache capacity remains 4 MiB, with query-headroom trimming. No Cloudflare isolate CPU/memory claim follows from host RSS.\n')
worker=read('next-workerd.json');rows=[]
for d in worker['rows']:
 times=sorted(s['ms'] for s in d['samples']);rows.append([d['name'],f(d['startupWallMs']),f(statistics.median(times)),f(times[math.ceil(len(times)*.95)-1]),sum(s['status']!=200 for s in d['samples'])])
out.append(table(['Local workerd configuration','Process/isolate startup wall ms','HTTP P50 ms','HTTP P95 ms','Failures'],rows))
out.append('Workerd runs 96 timed HTTP requests plus 32 exhaustive checks. Results/scores must match exactly within workerd; the separate Node oracle uses a 1e-12 score tolerance across runtimes. Startup includes local process launch/IPC and is not deployed startup CPU.\n')
out.append('## Reproduction\n```sh\nnpm test\nnpm run check\n# Retain the previous release\'s benchmark fixtures for the historical baseline.\nnode --import tsx bench/next-prepare.ts\nfor stage in 0 1 2 3 4 5 6 7; do node --import tsx bench/next.ts "$stage"; done\nnode --import tsx bench/next-matrix.ts\nnode --import tsx bench/next-worker.ts\nnode --import tsx bench/next-dense.ts\npython3 bench/next-report.py\n```\nThe internal optimizationStage switch is never exposed by HTTP. Running npm run bench with the current writer creates current-format fixtures, not the historical v5 bytes used in this report; preserve those fixtures or regenerate them using the preceding release.\n')
out.append('## Limits\nDirect block execution supports positive Boolean term trees; phrases, negation, metadata and exact-total requests use the established executor. AND aligns cursors; positive OR trees use a block-max union iterator, not pivot-WAND. Broad remote streams still use full frequency reads, so decoding/memory improvements do not imply fewer R2 bytes. Position seek tables avoid semantic scans but keep block CRC reads. The fixed 4 MiB cache does not bound simultaneous query working sets. No phrase accelerators, document reordering or scoring changes were added. v8 builds require a new immutable generation; current readers also support v5–v7.\n')
(root/'NEXT-OPTIMIZATIONS.md').write_text('\n'.join(out))
