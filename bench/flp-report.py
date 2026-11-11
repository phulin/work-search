import pathlib,json,statistics,math,shutil,random
root=pathlib.Path('bench'); generated=root/'generated'/'flp'
def read(p):return json.loads(pathlib.Path(p).read_text())
def pct(a,p):a=sorted(a);return a[max(0,math.ceil(len(a)*p)-1)]
def fmt(x):return f'{x:.2f}'
def table(headers,rows):return '|'+ '|'.join(headers)+'|\n|'+'|'.join(['---']*len(headers))+'|\n'+''.join('|'+ '|'.join(str(x) for x in row)+'|\n' for row in rows)
sample=read(generated/'sample-manifest.json');stats=read(generated/'corpus-stats.json');queries=read(generated/'queries.json');matrix=read(root/'results'/'flp-matrix.json');builds=read(root/'results'/'flp-builds.json')
for src,dst in [('sample-manifest.json','flp-sample-manifest.json'),('corpus-stats.json','flp-corpus-stats.json'),('queries.json','flp-queries.json')]:shutil.copyfile(generated/src,root/'results'/dst)
lines=['# Free Law Project real-text corpus benchmark\n']
lines.append(f"## Corpus and provenance\n{sample['documents']:,} full-text decisions sampled from [COLD Cases](https://huggingface.co/datasets/harvard-lil/cold-cases), Harvard Library Innovation Lab’s CourtListener repackaging prepared with Free Law Project, linked from [FLP’s bulk data documentation](https://wiki.free.law/c/courtlistener/help/api/bulk-data/bulk-legal-data). Dataset revision `{sample['revision']}`, seed `{sample['seed']}`; source inventory has {sample['source_rows']:,} rows across {len(sample['inventory'])} shards. Source license is CC0-1.0.\n")
lines.append(f"The sampler allocates decisions by shard size, chooses one row group per shard with probability proportional to row count, then samples eligible distinct decisions uniformly within that group. This is a stratified two-stage cluster sample, not an independent uniform sample of the full dataset. Source grouping can induce correlations. Empty texts and duplicate cluster IDs are excluded; no length cutoff or text truncation is applied. All opinions belonging to a decision are concatenated with two newlines; one engine document represents one decision. Final serving order is deterministically shuffled.\n\nCorpus JSONL: {sample['bytes']:,} bytes, SHA-256 `{sample['sha256']}`. The ignored local corpus is `bench/generated/flp/corpus.jsonl`; the committed sample manifest records every source file, row group, row and cluster ID.\n")
rows=[]
for label,key in [('Body tokens','bodyTokens'),('Title tokens','titleTokens')]:
 s=stats[key];rows.append([label,s['min'],s['p50'],s['p95'],s['max'],fmt(s['mean']),s['total']])
lines.append(table(['Measure','Min','P50','P95','Max','Mean','Total'],rows))
lines.append('Court-type and filing-decade distributions are in results/flp-corpus-stats.json. This sample measures real textual variation, not complete coverage of US law.\n')
lines.append('## Findings\nThe real sample exposes costs hidden by the uniform synthetic corpus: 145,185 dictionary terms and 7,009,789 mandatory bundled bytes for only 10,000 decisions. Every budget fits, but 8 MiB leaves limited posting space. All 15,360 timed Node searches and 192 local Worker HTTP requests succeed after the mixed-block decoder fix.\n')
lines.append('The new executor is not a universal win: plain, phrase and proximity uncached medians improve in the paired runs, but the current positive Boolean block iterator regresses on this workload. At 8 MiB with mixed embedding, Boolean mixed-cache median is about 0.87 → 1.98 ms; at 48 MiB it is about 3.67 → 8.50 ms. This is a concrete target for adaptive executor selection, not evidence that the real corpus is unsuitable. No tuning was applied to remove that regression from these results.\n')
lines.append('## Workload and timing\n64 training strings and 160 disjoint evaluation strings, balanced across plain terms, exact phrases, /n proximity and Boolean groups. They combine hand-authored legal terms with deterministically selected phrases/terms from sampled decisions. They are artificial stress queries, not attorney query logs; corpus-derived queries favor queries with matches. Shared terms between training/evaluation are intentional, but exact query strings are disjoint. Both embedding strategies see only the training strings.\n')
lines.append('Each index runs stages 0 (previous execution behavior) and 7 (new execution behavior) on the exact same v8 bytes. This isolates execution, not the encoding change. Each variant executes three shuffled passes without a retained runtime cache, then three shuffled mixed-query passes through its own 4 MiB LRU. Variant order is randomized within each pair. Validation, serialization and memory sampling are outside the timer. All successful results must match exact IDs/scores from exhaustive reference execution. The oracle prepass warms OS/file/index validation caches; “uncached” means no retained SearchRuntime, not a fresh isolate or cold storage. No immediate query repeats are required in the mixed-query stream.\n')
lines.append('Each full feasible configuration has 1,920 timed queries plus 160 oracle queries. Errors are retained and excluded from latency quantiles, with counts displayed. P50/P95 weight query types equally rather than modeling traffic popularity. All Node/FS measurements are local, sequential, without artificial network latency or concurrency. Configurations run in fixed order, so cross-budget comparisons can include host/JIT/GC/thermal drift; paired comparisons within a configuration are stronger than cross-budget absolute latency comparisons.\n')
lines.append('## Index feasibility and storage\n')
rows=[]
for r in matrix['results']:
 if r.get('infeasible'):rows.append([r['budget'],r['policy'],'infeasible',r['infeasible'],'','','']);continue
 rows.append([r['budgetMiB'],r['policy'],f"{r['bundleBytes']/1048576:.2f}",r['vocabulary'],r['mandatoryBytes'],r['frequencyBytes'],r['positionBytes']])
lines.append(table(['Budget MiB','Policy','Bundle MiB','Vocabulary','Mandatory bytes','Frequency bytes','Position bytes'],rows))
source=read(generated/'source'/'manifest.json');legacy=read(generated/'legacy'/'manifest.json')
lines.append(f"On the same real-text corpus, legacy varint frequency streams total {legacy['frequencyBytes']:,} bytes versus {source['frequencyBytes']:,} bytes for v8 ({100*(1-source['frequencyBytes']/legacy['frequencyBytes']):.1f}% smaller). Legacy positional streams total {legacy['positionBytes']:,} versus {source['positionBytes']:,} bytes in v8; optional seek tables trade space for selective access. Directory/dictionary/document data and all embedded payloads count against each budget. Total stored bytes, including metadata, are recorded per configuration.\n")
full=next(b for b in builds if b.get('kind')=='full corpus ingestion')
lines.append(f"Full JSONL ingestion build: {full['ms']/1000:.2f} seconds, {sample['documents']/(full['ms']/1000):.1f} decisions/second. This is a fresh full build with 100-document spill chunks. Remaining configurations are offline repacks of identical encoded streams; they are not counted as corpus build throughput.\n")
for phase in ['uncached','mixed-cache']:
 lines.append(f'## Execution: {phase}\n')
 rows=[]
 for r in matrix['results']:
  if r.get('infeasible'):continue
  for kind in ['plain','phrase','proximity','boolean']:
   data={}
   for variant in ['baseline','optimized']:
    s=[s for s in r['samples'] if s['phase']==phase and s['variant']==variant and s['kind']==kind and (phase!='mixed-cache' or s['pass']>0)];ok=[x for x in s if not x.get('error')];data[variant]=(s,ok)
   a,b=data['baseline'][1],data['optimized'][1]
   def latency(s,p):return fmt(pct([x['ms'] for x in s],p)) if s else 'n/a'
   rows.append([r['budgetMiB'],r['policy'],kind,f'{latency(a,.5)} → {latency(b,.5)}',f'{latency(a,.95)} → {latency(b,.95)}',fmt(statistics.mean(x['diagnostics']['indexRequests'] for x in b)) if b else 'n/a',fmt(sum(x['diagnostics']['indexRequests']==0 for x in b)*100/len(b)) if b else 'n/a',len(data['optimized'][0])-len(b)])
 lines.append(table(['MiB','Policy','Type','P50 ms baseline → optimized','P95 ms baseline → optimized','Optimized reads/query','Zero reads %','Optimized errors'],rows))
lines.append('## Local Worker validation\n')
worker_path=root/'results'/'flp-workerd.json'
if worker_path.exists():
 worker=read(worker_path);rows=[]
 for r in worker['rows']:
  values=[s['ms'] for s in r['samples']];rows.append([r['budget'],len(values),fmt(statistics.median(values)),fmt(pct(values,.95)),fmt(r['startupWallMs'])])
 lines.append(table(['MiB (mixed)','HTTP responses','P50 ms','P95 ms','Process startup wall ms'],rows))
 lines.append('The actual Wrangler-built Worker runs in local workerd/Miniflare with its R2 binding. Sixteen evaluation queries (four per type), three passes per feasible budget. Every response must succeed, omit total by default, and match exhaustive Node IDs/scores (1e-12 cross-runtime score tolerance). HTTP timing includes local dispatch and response parsing, excludes validation. Startup includes local process creation/IPC. This is not deployed Cloudflare/R2 latency or isolate startup CPU.\n')
lines.append('## Limits\nThe source sample is 10,000 decisions; do not extrapolate its dictionary/length distribution or latency linearly to millions. Some source decisions have multiple opinions and OCR artifacts. Concatenating opinions permits token-distance matching across opinion boundaries. Workload selection is artificial, equal-weight and partially corpus-derived; it cannot establish real traffic cache hit rates or relevance quality. The small local workerd workload is functional runtime validation. Host RSS includes oracle/fixture buffers and allocator retention, not isolate memory. No concurrent load, deployed R2, geographic latency or production eviction is measured. No ranking-quality judgments are supplied.\n')
lines.append('## Reproduction\n```sh\nuv venv work/flp-venv\nuv pip install --python work/flp-venv/bin/python -r bench/flp-requirements.txt\nwork/flp-venv/bin/python bench/sample-flp.py\nnode --import tsx bench/flp-prepare.ts\nnode --import tsx bench/flp-build.ts\nnode --import tsx bench/flp-run.ts\nnode --import tsx bench/flp-worker.ts\npython3 bench/flp-report.py\n```\nUse a fresh `bench/generated/flp/source` output for a new build: production generations are immutable and the builder rejects overwriting an existing generation. The sampler reads footers and one row group per shard, with source read traffic substantially exceeding the final sample size. The source dataset revision and dependency versions are pinned. Full texts/indexes stay in ignored generated files; source selection, corpus hash, workloads and raw benchmark results are committed.\n')
(root/'FREE-LAW-PROJECT.md').write_text('\n'.join(lines))
