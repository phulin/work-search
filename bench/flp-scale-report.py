#!/usr/bin/env python3
"""Report a separately named FLP corpus run, including infeasible bundle budgets."""
import argparse,collections,json,math,pathlib,shutil,statistics
p=argparse.ArgumentParser();p.add_argument('--root',default='bench/generated/flp-100000');p.add_argument('--prefix',default='flp100k');args=p.parse_args()
root=pathlib.Path(args.root);results=pathlib.Path('bench/results');prefix=args.prefix
read=lambda path:json.loads(pathlib.Path(path).read_text())
def f(x):return f'{x:.2f}'
def pct(xs,p):return sorted(xs)[math.ceil(len(xs)*p)-1]
def table(headers,rows):return '|'+ '|'.join(headers)+'|\n|'+'|'.join(['---']*len(headers))+'|\n'+''.join('|'+ '|'.join(map(str,r))+'|\n' for r in rows)
sample=read(root/'sample-manifest.json');stats=read(root/'corpus-stats.json');workload=read(root/'queries.json');builds=read(results/f'{prefix}-builds.json');index=read(results/f'{prefix}-boolean-final.json');worker=read(results/f'{prefix}-boolean-workerd.json');source=next(x for x in builds if x.get('kind')=='full corpus ingestion');configs=[read(results/r['file']) for r in index['rows'] if r.get('file')]
for name in ['sample-manifest','corpus-stats','queries']:shutil.copyfile(root/f'{name}.json',results/f'{prefix}-{name}.json')
prior=read(results/'flp-sample-manifest.json');previous_ids={x['id'] for x in prior['selection']};current_ids={x['id'] for x in sample['selection']};overlap=len(previous_ids&current_ids)
assert len(current_ids)==sample['documents']
assert overlap==len(previous_ids), 'Original sample must be retained'
assert workload==read(results/'flp-queries.json'),'Workload drift'
summary=[]
for r in configs:
 for kind in ['plain','phrase','proximity','boolean','wand-or','wand-heldout']:
  for phase in ['uncached','mixed-cache']:
   for variant in ['before','recovered','tree','wand','auto']:
    rows=[s for s in r['samples'] if s['kind']==kind and s['phase']==phase and s['variant']==variant and (phase!='mixed-cache' or s['pass']>0)];ok=[s for s in rows if not s.get('error')];times=[s['ms'] for s in ok]
    summary.append({'budgetMiB':r['budgetMiB'],'policy':r['policy'],'kind':kind,'phase':phase,'variant':variant,'p50':statistics.median(times) if times else None,'p95':pct(times,.95) if times else None,'cpuMs':statistics.mean(s['cpuMs'] for s in ok) if ok else None,'zeroReadsPct':100*sum(s['diagnostics']['indexRequests']==0 for s in ok)/len(ok) if ok else None,'reads':statistics.mean(s['diagnostics']['indexRequests'] for s in ok) if ok else None,'bytes':statistics.mean(s['diagnostics']['indexBytes'] for s in ok) if ok else None,'scored':statistics.mean(s['diagnostics']['scoredDocuments'] for s in ok) if ok else None,'samples':len(rows),'errors':len(rows)-len(ok)})
(results/f'{prefix}-summary.json').write_text(json.dumps(summary,indent=2))
def select(r,phase,variant='auto',kind=None):return [s for s in r['samples'] if s['phase']==phase and s['variant']==variant and (kind is None or s['kind']==kind) and (phase!='mixed-cache' or s['pass']>0)]
def perf(rows):
 ok=[s for s in rows if not s.get('error')];t=[s['ms'] for s in ok]
 return [f(statistics.median(t)),f(pct(t,.95)),f(100*sum(s['diagnostics']['indexRequests']==0 for s in ok)/len(ok)),f(statistics.mean(s['diagnostics']['indexRequests'] for s in ok)),round(statistics.mean(s['diagnostics']['indexBytes'] for s in ok)),len(rows)-len(ok)] if t else ['n/a']*5+[len(rows)]
lines=[f"# Free Law Project: {sample['documents']:,} decisions\n"]
lines.append(f"## Corpus and workload\nExpanded the pinned [COLD Cases](https://huggingface.co/datasets/harvard-lil/cold-cases) CourtListener/Free Law Project sample to {sample['documents']:,} untruncated decisions ({sample['bytes']:,} JSONL bytes). Source revision `{sample['revision']}`, seed `{sample['seed']}`, all {len(sample['inventory'])} source shards. All {overlap:,} original sampled decisions are retained. One document concatenates all opinions within a decision. SHA-256: `{sample['sha256']}`.\n")
lines.append('The source grouping and two-stage sampling limitations remain: one probability-proportional-to-size row group per shard, then uniform eligible rows within that group, shard quotas by total row count, deterministic final shuffle. This is clustered sampling, not an independent uniform sample of all US decisions. Shard checkpoints permit resuming without retaining full texts in RAM. Source locations, selected IDs, seed and corpus hash are recorded in the committed manifest; full texts/indexes stay in ignored generated files.\n')
lines.append('The original 64 embedding-training strings and 160 evaluation strings are unchanged. The Boolean/WAND supplement keeps the same 21 tuning OR strings and 40 separate OR strings: 221 evaluation queries total. No new tuning is performed for the larger corpus. Both embedding strategies see only the original training workload. Queries are artificial legal stress queries, not user logs or relevance judgments.\n')
rows=[]
for label,key in [('Body tokens','bodyTokens'),('Title tokens','titleTokens')]:
 s=stats[key];rows.append([label,s['min'],s['p50'],s['p95'],s['max'],f(s['mean']),s['total']])
lines.append(table(['Measure','Min','P50','P95','Max','Mean','Total'],rows))
lines.append('## All four budgets: feasibility\n')
rows=[];mandatory=source.get('mandatoryBytes',source.get('manifest',{}).get('dictionaryBytes',0)+source.get('manifest',{}).get('documentTableBytes',0))
for budget in [8,16,32,48]:
 for policy in ['frequency','mixed']:
  b=next(x for x in builds if x.get('budgetMiB')==budget and x.get('policy')==policy);r=next((x for x in configs if x['budgetMiB']==budget and x['policy']==policy),None)
  rows.append([budget,policy,'infeasible' if b.get('error') else 'measured',mandatory,f(r['bundleBytes']/1048576) if r else 'n/a',r['vocabulary'] if r else source.get('manifest',{}).get('terms','n/a')])
lines.append(table(['Budget MiB','Policy','Outcome','Mandatory bytes','Actual bundle MiB','Vocabulary'],rows))
lines.append('Infeasible budgets have no latency, zero-read rate or Worker startup measurement. A dictionary/table allocation that exceeds the budget is not represented as a zero-latency result. The sample is never truncated to fit, and no remote dictionary or larger budget is substituted. Raw build/repacking failures are in the build record.\n')
if source.get('manifest'):
 m=source['manifest'];lines.append(f"Full JSONL ingestion: {source['ms']/1000:.2f} seconds ({sample['documents']/(source['ms']/1000):.1f} decisions/second), peak builder-process RSS reported as {m.get('peakRssBytes',0):,} bytes. Dictionary: {m['dictionaryBytes']:,} bytes; document tables: {m['documentTableBytes']:,}; frequencies: {m['frequencyBytes']:,}; positions: {m['positionBytes']:,}. Subsequent variants are offline stream repacks, not additional ingestion-throughput measurements.\n")
lines.append('## Latest system: latency and R2 simulation\nAll runs are local. Uncached means no retained SearchRuntime, while OS/file/validation caches may already be warm. Mixed-cache measurements use shuffled traffic through one 4 MiB cache per variant, reporting passes 1–2. Variants are paired in randomized order on identical v8 bytes. Correctness checks, JSON hashing and memory sampling are outside the timer. Each feasible configuration has 6,630 timed searches across five controls, plus 221 exhaustive reference searches. Failed queries are counted and excluded from successful latency quantiles.\n')
for phase in ['uncached','mixed-cache']:
 rows=[]
 for r in configs:rows.append([r['budgetMiB'],r['policy'],*perf(select(r,phase))])
 lines.append('### '+phase+'\n'+table(['MiB','Policy','Auto P50 ms','Auto P95 ms','Zero index reads %','Index reads/query','Index bytes/query','Errors'],rows))
lines.append('## Query type detail: mixed embedding\n')
rows=[]
for r in configs:
 if r['policy']!='mixed':continue
 for kind in ['plain','phrase','proximity','boolean','wand-or','wand-heldout']:
  for phase in ['uncached','mixed-cache']:rows.append([r['budgetMiB'],kind,phase,*perf(select(r,phase,kind=kind))])
lines.append(table(['MiB','Type','Cache mode','P50 ms','P95 ms','Zero reads %','Reads/query','Bytes/query','Errors'],rows))
lines.append('## Execution controls at scale\n')
rows=[]
for r in configs:
 if r['policy']!='mixed':continue
 for kind in ['boolean','wand-heldout']:
  for phase in ['uncached','mixed-cache']:
   for variant in ['before','recovered','tree','wand','auto']:rows.append([r['budgetMiB'],kind,phase,variant,*perf(select(r,phase,variant,kind))[:2]])
lines.append(table(['MiB','Type','Cache mode','Executor','P50 ms','P95 ms'],rows))
lines.append('Before freezes the previous block executor; recovered disables WAND for supplemental/held-out OR queries; tree and wand force their eligible executors; auto is the latest default. Field-aware bounds, scores and deterministic ties remain exact. Raw records include CPU, decoded blocks, pivot/seek diagnostics, request/byte counts, cache retention, RSS and heap observations. Host RSS includes reference/index buffers and multiple cache contexts; it is not isolate memory.\n')
bundle_file=results/f'{prefix}-bundles.json'
if bundle_file.exists():
 bundles=read(bundle_file);rows=[[r['budgetMiB'],f(r['rawUploadKiB']),f(r['gzipKiB'])] for r in bundles['rows'] if not r.get('infeasible')]
 lines.append('## Worker packaging\n'+table(['MiB index','Wrangler total upload KiB','Gzip KiB (reference only)'],rows))
 lines.append('Both feasible binary fixtures pass Wrangler dry-run packaging with the current Worker code. [Current Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/) checked November 11, 2026 allow 64 MiB uncompressed Worker size; gzip is not the size limit. These bundles are below that size ceiling. Account deployment, startup CPU and production isolate-memory safety are not established by a dry run.\n')
lines.append('## Comparison with the 10,000-decision run\nSame engine, query strings and control structure; different sample size/corpus statistics. Configurations are not interleaved across corpus sizes, so host/JIT/GC/thermal differences can affect absolute scaling ratios.\n')
rows=[]
for r in configs:
 if r['policy']!='mixed':continue
 oldfile=results/f"boolean-wand-final-{r['budgetMiB']}-mixed.json"
 if not oldfile.exists():continue
 old=read(oldfile)
 for phase in ['uncached','mixed-cache']:
  a=perf(select(old,phase));b=perf(select(r,phase));rows.append([r['budgetMiB'],phase,a[0]+' → '+b[0],a[1]+' → '+b[1],a[2]+' → '+b[2],a[3]+' → '+b[3]])
lines.append(table(['MiB','Cache mode','P50 ms 10k → 100k','P95 ms 10k → 100k','Zero reads % 10k → 100k','Reads/query 10k → 100k'],rows))
lines.append('## Actual local Worker\n')
rows=[]
for r in worker['rows']:
 t=[s['ms'] for s in r['samples']];routes=collections.Counter(s['diagnostics']['executor'] for s in r['samples']);rows.append([r['budget'],len(t),f(statistics.median(t)),f(pct(t,.95)),f(r['startupWallMs']),str(dict(routes))])
lines.append(table(['MiB, mixed','HTTP responses','P50 ms','P95 ms','Process startup wall ms','Routes exercised'],rows))
lines.append('Wrangler-built code runs in actual local workerd with Miniflare R2 bindings. Every timed response is checked against exhaustive Node results with 1e-12 cross-runtime score tolerance, and extra untimed requests compare every timed result and fresh default results exactly against exhaustive scores inside workerd. Assertions require WAND and Boolean-block routes to be exercised before cache warmup. Startup includes local process creation/IPC. No deployed Cloudflare/R2 latency, account-limit validation or concurrent-load result is claimed.\n')
lines.append('## Reproduction\n```sh\nuv venv --python 3.12 work/flp-venv\nuv pip install --python work/flp-venv/bin/python -r bench/flp-requirements.txt\nwork/flp-venv/bin/python bench/sample-flp.py --count 100000 --out bench/generated/flp-100000\nexport FLP_ROOT=bench/generated/flp-100000\nexport FLP_PREFIX=flp100k\nexport FLP_QUERY_SOURCE=bench/results/flp-queries.json\nnode --import tsx bench/flp-prepare.ts\nnode --import tsx bench/flp-build.ts\nnode --import tsx bench/boolean-run.ts\nnode --import tsx bench/boolean-worker.ts\nnode --import tsx bench/flp-bundle.ts\npython3 bench/flp-scale-report.py\n```\nSource generations are immutable; use a fresh source output for a fresh build, or `flp-build.ts --reuse-source` after a completed verified build to repeat offline repacks. Sampling checkpoints are hash-checked and scoped by revision/count/seed. The 10k corpus and its reports are not overwritten. Main limits remain artificial query weights, clustered sampling, local storage latency, whole-stream cold frequency fetches in WAND, and unmeasured concurrent isolate memory.\n')
pathlib.Path('bench/FLP-100K.md').write_text('\n'.join(lines))
print(json.dumps({'documents':sample['documents'],'originalIdsRetained':overlap,'attemptedConfigurations':len(index['rows']),'feasibleConfigurations':len(configs),'measuredQueries':sum(r.get('queries',0) for r in index['rows']),'queryErrors':sum(r.get('errors',0) for r in index['rows']),'workerResponses':sum(len(r['samples']) for r in worker['rows'])}))
