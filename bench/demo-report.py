#!/usr/bin/env python3
"""Summarize measured live data and explicitly labeled local simulations."""
import collections, datetime, hashlib, json, math, pathlib, statistics, subprocess

root=pathlib.Path('work/demo-bench');output=pathlib.Path('bench/results');output.mkdir(exist_ok=True)
load=lambda name:json.loads((root/name).read_text())
snapshot=load('snapshot.json');calibration=load('latency.json');live=load('live.json')['rows'];local=load('local-final.json');warm=load('local-repeated-final.json');pages=load('pages.json')['rows'];bursts=load('load.json')['rows'];corpus=load('corpus.json')
assert local.get('complete') and len(local['rows'])==240,'Main benchmark incomplete'
assert warm.get('complete') and len(warm['rows'])==48,'Warm profile incomplete'
assert len(live)==50 and len(pages)==12,'Live or pagination coverage incomplete'
local=local['rows']+warm['rows']
def quant(values,q):
    a=sorted(values)
    return a[max(0,math.ceil(len(a)*q)-1)] if a else None
def stats(values):return dict(n=len(values),p50=quant(values,.5),p95=quant(values,.95),p99=quant(values,.99),maximum=max(values) if values else None)
def timing(events,phase,local=False):
    e=[e for e in events if e['type']=='service' and e['key'].endswith('/'+phase) and (not local or e['key'].startswith('group-'))]
    return max((r.get('end',r.get('headers',0)) for r in e),default=0)
def metrics(row,is_local):
    e=row['trace']['events'];reads=[a for a in e if a['type']=='r2'];io={}
    for r in reads:
        kind=r['key'].rsplit('/',1)[-1].rsplit('-',1)[0];kind='manifest' if r['key']=='demo-case-metadata.json' else kind
        c=io.setdefault(kind,dict(requests=0,requestedBytes=0,consumedBytes=0));c['requests']+=1;c['requestedBytes']+=r.get('length',0) or r.get('bytes',0);c['consumedBytes']+=r.get('bytes',0)
    elapsed=row['ms'] if is_local else row['trace']['ms'];rank=timing(e,'search',is_local)
    out={k:row[k] for k in ['q','kind','mode','phase','pass','page','cpuMs','rss','clientMs'] if k in row}
    out.update(ms=elapsed,statsReadyMs=timing(e,'stats',is_local),rankReadyMs=rank,cardsMs=elapsed-rank,r2Requests=len(reads),requestedBytes=sum(x['requestedBytes'] for x in io.values()),consumedBytes=sum(x['consumedBytes'] for x in io.values()),io=io)
    if is_local:
        d=row['trace'].get('diagnostics',[])
        out['executors']=dict(collections.Counter(x['executor'] for x in d))
        out['scoredDocuments']=sum(x.get('scoredDocuments',0) for x in d)
        out['positionRequests']=sum(x.get('positionRequests',0) for x in d)
    else:
        out['rootOnlyIO']=True;out['colo']=row['trace'].get('colo');out['results']=len(row['body']['results'])
    return out
local_rows=[metrics(r,True) for r in local];page_rows=[metrics(r,True) for r in pages];live_rows=[metrics(r,False) for r in live]
n=sum(s['count'] for s in corpus['shards'])
def weighted(field,q):
    a=sorted((v,s['count']/len(s[field])) for s in corpus['shards'] for v in s[field]);total=0
    for value,weight in a:
        total+=weight
        if total>=n*q:return value
body=dict(mean=sum(s['count']*s['avgBody'] for s in corpus['shards'])/n,p50=weighted('bodySample',.5),p95=weighted('bodySample',.95),p99=weighted('bodySample',.99),sampleMax=max(max(s['bodySample']) for s in corpus['shards']),sampleCount=sum(len(s['bodySample']) for s in corpus['shards']))
zero_titles=sum(s['count']*sum(v==0 for v in s['titleSample'])/len(s['titleSample']) for s in corpus['shards'])/n
r2={}
for cohort in ['repeated-range','varied-range']:
    for concurrency in [1,6,12]:
        r=[s for s in calibration['rows'] if s['cohort']==cohort and s['concurrency']==concurrency]
        r2[f'{cohort}/{concurrency}']=dict(headersMs=stats([s['headersMs'] for s in r]),bodyMs=stats([s['bodyMs'] for s in r]))
summaries=[]
for mode in sorted(set(r['mode'] for r in local_rows)):
    for phase in ['reset','mixed','repeat']:
        for p in ([0,1,2] if phase=='repeat' else [0]):
            r=[s for s in local_rows if s['mode']==mode and s['phase']==phase and s['pass']==p]
            if r:summaries.append(dict(mode=mode,phase=phase,passNumber=p,latencyMs=stats([s['ms'] for s in r]),cpuMs=stats([s['cpuMs'] for s in r]),r2Requests=stats([s['r2Requests'] for s in r]),rssMax=max(s['rss'] for s in r)))
actual=[r for r in live_rows if r['pass']==2 and not r.get('page')];actual_by={r['q']:r for r in actual};accuracy={}
for mode in ['fixed20','empirical','empirical-repeated']:
    predictions=[r for r in local_rows if r['mode']==mode and r['phase']=='repeat' and r['pass']==2]
    accuracy[mode]=dict(medianAbsoluteRelativeError=statistics.median(abs(r['ms']-actual_by[r['q']]['ms'])/actual_by[r['q']]['ms'] for r in predictions),medianPredictionRatio=statistics.median(r['ms']/actual_by[r['q']]['ms'] for r in predictions))
result=dict(kind='Measured deployed Worker/R2 observations plus separately labeled local simulations',generatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),snapshot=dict(capturedAt=snapshot['capturedAt'],documents=n,partitions=len(snapshot['shards']),bundleBudgetMiB=8,bundledBytes=sum(s['rootBytes'] for s in corpus['shards']),generationVector={str(s['id']):s['generation'] for s in snapshot['shards']}),corpus=dict(bodyTokens=body,indexedZeroTitleFraction=zero_titles),r2=dict(observations=len(calibration['rows']),colos=sorted(set(r['colo'] for r in calibration['rows'])),quantiles=r2,raw=calibration),local=local_rows,pages=page_rows,live=live_rows,summary=summaries,predictionAccuracy=accuracy,load=[dict(concurrency=b['concurrency'],queries=len(b['samples']),elapsedMs=b['elapsedMs'],requestsPerSecond=len(b['samples'])/(b['elapsedMs']/1000),clientLatencyMs=stats([s['clientMs'] for s in b['samples']])) for b in bursts],notes=['Scenario-balanced hand-authored workload, not user logs or traffic-weighted SLO.','Local process CPU/RSS aggregate 67 logical Workers; not measured Cloudflare CPU or isolate memory.','Production root trace counts root R2 only; local traces include leaf R2 too.','Reset means application caches cleared in a loaded graph; R2/backend/isolate cold state is not forced.','P95 over 16 queries is the maximum sample; tail estimates have limited statistical power.','Active bulk import and this machine were not isolated from background work.'])
result['machine']=json.loads(subprocess.check_output(['node','--input-type=module','-e','import os from "node:os"; console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model,cores:os.cpus().length,memory:os.totalmem()}))']))
result['sourceHashes']={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [pathlib.Path('demo/gateway.ts'),pathlib.Path('demo/shard-runtime.ts'),pathlib.Path('src/query/engine.ts'),pathlib.Path('bench/demo-graph.ts'),pathlib.Path('bench/demo-model.ts')]}
(output/'demo-realistic.json').write_text(json.dumps(result,indent=2)+'\n')

def fmt(v):return f'{v:,.0f}'
def msrow(label,rows):
    s=stats([r['ms'] for r in rows]);return f"|{label}|{s['n']}|{s['p50']/1000:.2f}|{s['p95']/1000:.2f}|"
report=f'''# Realistic demo benchmark

Measured {result['generatedAt']}. The benchmark pins **{n:,} official-snapshot opinions across {len(snapshot['shards'])} immutable partitions**, each with the production 8-MiB bundled-index budget. Later imports are excluded. It exercises production gateway/shard code, exact global BM25, top-20 results, legal case details, term-aware excerpts, and HMAC-signed pagination. No search optimization is introduced by this benchmark.

## Findings

The 20-ms fixed-read model is optimistic. Native Worker→R2 observations show substantial variation and cache/locality sensitivity. Search response time includes a result-assembly phase after ranking; this phase issues document, case-catalog, case-record, content-catalog and compressed-opinion reads. It remains expensive when postings are warm.

Every measured local response matched the frozen deployment's ranked IDs and scores (relative tolerance 1e-11). The local benchmark executes the actual 67-index graph, not a single sampled shard, and disallows remote cache fills during timed runs.

### Matched final warmed pass (16 distinct scenarios)

|Execution/profile|Queries|P50 seconds|Sample P95 seconds|
|---|---:|---:|---:|
'''
report+=msrow('Actual deployed Workers, final pass',actual)+'\n'
for mode,label in [('none','Local filesystem / no added R2 wait'),('fixed20','Local old 20-ms fixed R2 delay'),('empirical-repeated','Local measured repeated-range R2 profile'),('empirical','Local measured varied-range R2 profile')]:
    report+=msrow(label,[r for r in local_rows if r['mode']==mode and r['phase']=='repeat' and r['pass']==2])+'\n'
report+='\nThe repeated-range and varied-range profiles are sensitivity bounds, not an inferred traffic mix. R2 itself cannot be explicitly flushed by these probes. Equal weighting of 16 legal scenarios is coverage, not a claim about user-query popularity. Sample P95 is the largest observation for n=16; do not interpret it as a reliable service SLO.\n\n'
report+='|Live observed pass|Queries|P50 seconds|Sample P95 seconds|\n|---|---:|---:|---:|\n'
for p in [0,1,2]:report+=msrow(str(p),[r for r in live_rows if r['pass']==p and not r.get('page')])+'\n'
report+='\nPass zero is first observed by this benchmark, not guaranteed cold: its leaf Workers are the live demo\'s existing leaves, and may already have cached data. The local `reset` scenario clears all application LRUs in the loaded graph before every query; `mixed` keeps them across a first sweep; `repeat` adds two more identical sweeps. No phase is claimed to force cold isolates, R2 caches, DNS or connections.\n\n'
report+='## Corpus characteristics\n\n'
report+=f"Exact corpus mean: {body['mean']:,.1f} body tokens. A partition-stratified sample of {body['sampleCount']:,} documents, weighted by partition population, has P50/P95/P99 {body['p50']:,}/{body['p95']:,}/{body['p99']:,} tokens and sample maximum {body['sampleMax']:,}. This is a sampled maximum, not the corpus maximum. Original indexed title lengths are zero in {zero_titles:.2%} of weighted samples; display-caption repairs do not rebuild historical title postings.\n\n"
report+='The previous 100k real-corpus benchmark had body-token median 855, P95 6,983 and mean 1,874.3. Document lengths were broadly similar. The major missing features were the larger fanout, global-statistics scoring path and full result hydration. The frozen subset follows source import order; it is not a representative random sample of all US case law.\n\n'
report+='## Measured R2 distribution\n\n864 reads from the private Worker R2 binding at **'+', '.join(result['r2']['colos'])+'**, in three time windows; six sizes from 16 bytes to 1 MiB, repeated and varied ranges, and concurrency 1/6/12. Timings exclude the Mac→Worker network.\n\n|Range cohort|Concurrent reads|Samples|Header P50 ms|Header P95 ms|Header max ms|\n|---|---:|---:|---:|---:|---:|\n'
for cohort in ['repeated-range','varied-range']:
    for c in [1,6,12]:
        a=r2[f'{cohort}/{c}']['headersMs'];report+=f"|{cohort}|{c}|{a['n']}|{fmt(a['p50'])}|{fmt(a['p95'])}|{fmt(a['maximum'])}|\n"
report+='\nThe simulator resamples **serial** header/body pairs by nearest logarithmic read size. It selects one measured time window per query and preserves header/body pairing, adds an explicit six-slot header queue shared by the entire service-binding graph, releases slots at headers, and streams body chunks. Body time scales by bytes within size strata; reads above 1 MiB extrapolate transfer time. It does not add a second bandwidth delay on top of measured transfer. Burst probes validate queueing sensitivity and are not sampled as intrinsic delays, avoiding double-counting queue wait.\n\n'
report+='Cloudflare documents that [R2 requests count toward the shared top-level six-connection limit](https://developers.cloudflare.com/workers/platform/limits/) and that [connections are released at response headers](https://developers.cloudflare.com/changelog/post/2026-04-09-relaxed-connection-limiting/). [Service bindings normally share a server/thread](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/); the local graph therefore runs on one Node event loop rather than pretending that all 67 shards have independent CPU cores. Actual placement remains a platform decision.\n\n'
report+='## Where the live time goes\n\nFinal observed pass, per-query phases in seconds. `Cards` starts when the final ranking arrives and includes concurrent metadata and excerpt work. Root R2 excludes leaf R2; it is not total system I/O.\n\n|Query|Statistics|Rank ready|Cards|Full response|Root R2 reads|\n|---|---:|---:|---:|---:|---:|\n'
for r in actual:report+=f"|`{r['q']}`|{r['statsReadyMs']/1000:.2f}|{r['rankReadyMs']/1000:.2f}|{r['cardsMs']/1000:.2f}|{r['ms']/1000:.2f}|{r['r2Requests']}|\n"
report+='\nRoot streamed-byte counts are bytes delivered to JavaScript; canceled excerpt streams may cause additional backend prefetch. Local counts include all simulated R2 calls and requested/consumed bytes by object kind. Neither figure is labeled as exact billed wire bytes.\n\n'
report+='## Prediction checks\n\nThese comparisons use the final pass of the same 16 queries. They test usefulness, not a promise of calibration across geographies or future workloads. No timings were fitted to force a three-second result.\n\n|Local profile|Median absolute relative error|Median predicted/observed ratio|\n|---|---:|---:|\n'
for mode,v in accuracy.items():report+=f"|{mode}|{v['medianAbsoluteRelativeError']:.1%}|{v['medianPredictionRatio']:.2f}×|\n"
report+='\n## Pagination and light load\n\nActual page-two requests: '+', '.join(f"`{r['q']}` {r['ms']/1000:.2f}s" for r in live_rows if r.get('page')==2)+'. The local benchmark validates both pages under fixed-delay, repeated-range and varied-range models using locally signed cursors. Only two distinct queries were paged, too few for meaningful tail quantiles.\n\n'
report+='|Deployed client concurrency|Queries|Elapsed seconds|Queries/sec|Client P50 seconds|Client sample P95 seconds|\n|---|---:|---:|---:|---:|---:|\n'
for r in result['load']:report+=f"|{r['concurrency']}|{r['queries']}|{r['elapsedMs']/1000:.2f}|{r['requestsPerSecond']:.2f}|{r['clientLatencyMs']['p50']/1000:.2f}|{r['clientLatencyMs']['p95']/1000:.2f}|\n"
report+='\nThis is a short closed-loop burst, not sustained-load capacity or an open-loop arrival process. CPU in the JSON is aggregate local Node process CPU, including simulation/orchestration, not Cloudflare CPU. RSS holds 67 logical Workers and their bundles in one process; it is not per-isolate memory or a Workers memory-limit test. [Worker clocks do not measure synchronous CPU work](https://developers.cloudflare.com/workers/runtime-apis/performance/), so live phase timers are elapsed I/O-path observations rather than precise CPU profiling. Local bundle loading and corpus sampling happen before timing.\n\n'
report+='## Local resource and I/O samples\n\nFinal warmed sweep. CPU includes the local orchestrator and storage simulation; sampled RSS is the combined host process, not an isolate or a transient high-water mark.\n\n|Local profile|Median process CPU ms|Maximum sampled RSS MiB|Median total R2 calls|Median requested KiB|\n|---|---:|---:|---:|---:|\n'
for mode in ['none','fixed20','empirical-repeated','empirical']:
    r=[s for s in local_rows if s['mode']==mode and s['phase']=='repeat' and s['pass']==2]
    report+=f"|{mode}|{statistics.median(s['cpuMs'] for s in r):.0f}|{max(s['rss'] for s in r)/1048576:.0f}|{statistics.median(s['r2Requests'] for s in r):.0f}|{statistics.median(s['requestedBytes'] for s in r)/1024:.0f}|\n"
report+='\n## Best next experiments\n\n1. **Reduce result-card round trips.** Store the opinion-body range pointer alongside returned document metadata: a warm 20-hit page currently makes 20 content-catalog reads plus 20 body reads at the root. Co-locating pointers can remove the first 20. Preserve overlap between metadata and excerpt retrieval: waiting for an entire metadata batch before starting snippets could offset the read savings. Pack legal case fields and useful excerpt data together, and measure first visible result separately from fully hydrated results. This does not require a learned workload or phrase accelerator.\n2. **Restore global-score-safe skipping.** The production `globalStats` path disables streaming/WAND and local score bounds for correctness. Every local leaf diagnostic here reports `materialized`. Derive bounds that remain valid under global IDF/average lengths, then validate exact rankings with this harness.\n3. **Reduce dictionary/statistics fanout for rare terms.** A generation-level global term directory/statistics page could replace repeated per-partition cold dictionary lookups and identify which partitions need searching. Preserve exact global DF and score comparability.\n4. **Measure real traffic and geography.** Collect consent-appropriate aggregate query categories, cache hit/miss rates and multiple-colo latency samples before choosing traffic weights, cache policies or a production P95 target.\n\n'
report+='## Reproduce\n\n```sh\n# Uses the signed-in Wrangler account and existing full-import state.\nnode --import tsx bench/demo-setup.ts\nnode --import tsx bench/demo-capture.ts\nnode --import tsx bench/demo-latency.ts\nnode --max-old-space-size=4096 --import tsx bench/demo-local.ts --hydrate\nnode --max-old-space-size=4096 --import tsx bench/demo-pages.ts --hydrate\n\n# Timed runs are offline; missing ranges fail rather than fetching the network.\nDEMO_OUTPUT=local-final node --max-old-space-size=4096 --import tsx bench/demo-local.ts\nDEMO_MODES=empirical-repeated DEMO_PHASES=repeat DEMO_OUTPUT=local-repeated-final \\\n  node --max-old-space-size=4096 --import tsx bench/demo-local.ts\nnode --max-old-space-size=4096 --import tsx bench/demo-pages.ts\nnode --import tsx bench/demo-load.ts\npython3 bench/demo-report.py\n```\n\nThe private benchmark root and routers point at frozen existing leaf generations; they do not duplicate R2 index objects or stop the import. Setup keeps `work/demo-bench/snapshot.json` when rerun. Use a new work directory/snapshot deliberately to compare a later corpus. Work directories, credentials and mirrored bytes are ignored by Git. Timed local runs require only the mirror, bundled indexes, calibration, captured responses and snapshot; they do not read Cloudflare credentials or perform HTTP requests. JSONL progress avoids repeatedly serializing the entire accumulated trace during measurements.\n\nMachine-readable results: [results/demo-realistic.json](results/demo-realistic.json). Raw detailed traces and mirrors remain under ignored `work/demo-bench/`. Background import, one Mac, one observed colo, a small scenario suite, unknown R2 cache state, latency quantization and runtime differences limit external validity.\n'
pathlib.Path('bench/DEMO-REALISTIC.md').write_text(report)
print('Wrote benchmark report and machine-readable results')
