import json, statistics, math, pathlib
base=pathlib.Path('bench/results'); records=[]
def pct(xs,p):
 xs=sorted(xs);return xs[max(0,math.ceil(len(xs)*p)-1)]
lines=['# R2-backed paged index: 100,000 Free Law Project decisions','',
'Local Node/filesystem simulation. Fixed latency is added to every actual storage read; concurrent requests overlap. These are not deployed Cloudflare latency measurements. The model has no jitter, bandwidth limit, packet loss, or location effects. Timer scheduling can exceed the requested delay.','',
'## Method','',
'The frozen 160-query evaluation workload contains 40 plain, 40 Boolean, 40 phrase, and 40 proximity queries. All searches request the best 20 IDs/scores with exact totals disabled. Every timed result is checked against the existing exhaustive executor after timing. The baseline uses the existing 32/48 MiB mixed-policy generations. The paged generation uses identical posting codecs, document order, statistics, and scoring, and embeds no postings or term descriptors. The 8/16 MiB bundled baselines remain infeasible (30.2 MiB mandatory data); one identical paged root fits every budget, so it is measured once rather than relabeled four times.','',
'Cold means a fresh empty 4 MiB engine cache for every query. Mixed means two sequential workload passes sharing a 4 MiB cache; it includes the initial cold pass. OS file caches may be warm. Each design/delay combination runs in a separate child process. Correctness references are loaded from a small setup file, without retaining the baseline index in paged benchmark processes. Memory is sampled process RSS after queries, not peak isolate memory. CPU is process CPU consumed during the timed query. Startup includes local file loading and index construction, not Cloudflare startup CPU.','',
'## Results','',
'| Design | Added ms/read | Cache | P50 ms | P95 ms | CPU ms/query | Reads/query | KiB/query | Zero reads |',
'|---|---:|---|---:|---:|---:|---:|---:|---:|']
summary=[]
for design in ['32-mixed','48-mixed','paged']:
 for delay in [0,5,20]:
  r=json.loads((base/f'paged-{design}-{delay}.json').read_text());records.append(r)
  for phase in ['cold','mixed']:
   rows=[x for x in r['rows'] if x['phase']==phase];s=dict(design=design,delayMs=delay,phase=phase,samples=len(rows),p50=pct([x['ms'] for x in rows],.5),p95=pct([x['ms'] for x in rows],.95),cpu=statistics.mean(x['cpuMs'] for x in rows),reads=statistics.mean(x['requests'] for x in rows),bytes=statistics.mean(x['bytes'] for x in rows),zeroPct=100*statistics.mean(x['requests']==0 for x in rows));summary.append(s)
   lines.append(f"| {design} | {delay} | {phase} | {s['p50']:.2f} | {s['p95']:.2f} | {s['cpu']:.2f} | {s['reads']:.2f} | {s['bytes']/1024:.1f} | {s['zeroPct']:.1f}% |")
lines+=['','## Bundle, storage and process memory','','| Design | Bundle MiB | R2 MiB | Startup ms (range) | Sampled max RSS MiB (range) |','|---|---:|---:|---|---|']
for design in ['32-mixed','48-mixed','paged']:
 m=json.loads(pathlib.Path(f'bench/generated/flp-100000/{design}/manifest.json').read_text());rs=[r for r in records if r['design']==design];
 lines.append(f"| {design} | {m['bundleBytes']/1048576:.3f} | {sum(o['size'] for o in m['objects'])/1048576:.1f} | {min(r['startupMs'] for r in rs):.2f}–{max(r['startupMs'] for r in rs):.2f} | {min(r['maxProcessRss'] for r in rs)/1048576:.1f}–{max(r['maxProcessRss'] for r in rs)/1048576:.1f} |")
lines+=['','## By query type, +20 ms/read, cold cache','','| Design | Type | P50 ms | P95 ms | Reads/query |','|---|---|---:|---:|---:|']
for r in records:
 if r['latencyMs']!=20:continue
 for kind in sorted(set(x['kind'] for x in r['rows'])):
  xs=[x for x in r['rows'] if x['kind']==kind and x['phase']=='cold'];lines.append(f"| {r['design']} | {kind} | {pct([x['ms'] for x in xs],.5):.2f} | {pct([x['ms'] for x in xs],.95):.2f} | {statistics.mean(x['requests'] for x in xs):.2f} |")
worker=json.loads((base/'paged-workerd.json').read_text());lines+=['','## Actual local Worker verification','',f'{len(worker)} HTTP responses ran through the packaged Worker and Miniflare/workerd R2 binding, including plain, Boolean, phrase, proximity, missing terms, and Unicode queries. IDs and ordering matched the exhaustive reference, with a 1e-12 score tolerance across JS runtimes. Worker timings are local only; no artificial latency is injected in this check.','',
'## Interpretation and limits','',
'The actual 100k paged root passed Wrangler packaging: 279.97 KiB total uncompressed Worker upload (76.82 KiB gzip for reference). The root alone is 176,550 bytes. This dry run proves packaging compatibility, not deployed startup or isolate memory behavior.','',
'The small bundle demonstrates that the complete dictionary and document tables no longer need to fit in a Worker. It does not establish that 10 million real documents meet latency or memory targets. Cold paging introduces additional read phases, particularly dictionary and external-ID resolution, and can increase latency despite transferring fewer posting bytes. The existing bundled design is favored when its dictionary and hot postings fit.','',
'The paged block executor uses verified directories, 64 KiB frequency read-ahead, existing WAND bounds, and lazy document-length pages with four-page read-ahead. Phrase, proximity, negation, metadata, and exact-total queries retain the materialized executor with selective posting ranges. Materialized working-set checks and the 16 MiB query-local norm-page guard may reject very broad searches on much larger corpora. A forward index, result cache, continuation pagination, compressed dictionary pages, adaptive read-ahead, and retained search state are not implemented by this change.','',
'Object counts and bytes are in each manifest. Estimated Class B operations per million queries are mean reads/query × 1,000,000; result/length/dictionary I/O is included. Converting that to dollars requires the applicable current R2 plan. Local process RSS includes Node/tsx and is not evidence of Worker isolate memory compliance.','',
'## Reproduce','',
'```sh',
'node --import tsx src/cli/main.ts page --source bench/generated/flp-100000/48-mixed --out bench/generated/flp-100000/paged',
'node --import tsx bench/paged.ts',
'node --import tsx bench/paged-worker.ts',
'python3 bench/paged-report.py','```','',
'The corpus and frozen queries are the same as [FLP-100K.md](FLP-100K.md). Repacking is not a new corpus-ingestion throughput measurement. Choose a fresh output directory when reproducing the immutable generation.']
pathlib.Path('bench/PAGED-INDEX.md').write_text('\n'.join(lines)+'\n');(base/'paged-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(f'{sum(len(r["rows"]) for r in records)} timed searches checked')
