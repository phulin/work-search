import json,pathlib,math,statistics
root=pathlib.Path('bench');results=root/'results'
def read(name):return json.loads((results/name).read_text())
def pct(values,p):return sorted(values)[math.ceil(len(values)*p)-1]
def f(x):return f'{x:.2f}'
def table(headers,rows):return '|'+ '|'.join(headers)+'|\n|'+'|'.join(['---']*len(headers))+'|\n'+''.join('|'+ '|'.join(map(str,row))+'|\n' for row in rows)
index=read('boolean-final.json');configs=[read(x['file']) for x in index['rows']]
def subset(r,kind,variant,phase):return [s for s in r['samples'] if s['kind']==kind and s['variant']==variant and s['phase']==phase and (phase!='mixed-cache' or s['pass']>0)]
def metrics(samples):
 good=[s for s in samples if not s.get('error')];times=[s['ms'] for s in good];d=[s['diagnostics'] for s in good]
 return {'p50':statistics.median(times),'p95':pct(times,.95),'cpuMs':statistics.mean(s['cpuMs'] for s in good),'reads':statistics.mean(x['indexRequests'] for x in d),'bytes':statistics.mean(x['indexBytes'] for x in d),'scored':statistics.mean(x['scoredDocuments'] for x in d),'visited':statistics.mean(x.get('visitedDocuments',0) for x in d),'blocksDecoded':statistics.mean(x.get('blocksDecoded',0) for x in d),'cursorSeeks':statistics.mean(x.get('cursorSeeks',0) for x in d),'wandPivots':statistics.mean(x.get('wandPivots',0) for x in d),'wandSkips':statistics.mean(x.get('wandSkips',0) for x in d),'errors':len(samples)-len(good),'count':len(samples)}
summary=[]
for r in configs:
 for kind in ['plain','phrase','proximity','boolean','wand-or','wand-heldout']:
  for phase in ['uncached','mixed-cache']:
   for variant in ['before','recovered','tree','wand','auto']:
    summary.append({'budgetMiB':r['budgetMiB'],'policy':r['policy'],'kind':kind,'phase':phase,'variant':variant,**metrics(subset(r,kind,variant,phase))})
(results/'boolean-summary.json').write_text(json.dumps(summary,indent=2))
lines=['# Boolean recovery, then pivot WAND\n']
lines.append('## Implementation and scope\nThe Boolean recovery was implemented and benchmarked first, then WAND was added and benchmarked separately. Index bytes, embedded budgets (8/16/32/48 MiB), BM25 arithmetic, tie ordering and the 4 MiB cache cap remain unchanged. Existing v6–v8 indexes with persisted impacts support both block executors; v5, positional/negative queries, metadata requests and exact-total requests keep the materialized executor. No index rebuild or re-upload is needed for this execution-only change.\n')
lines.append('Small mixed Boolean trees now use sorted materialized set operations; large trees can use compiled AND/OR iterators ordered by estimated document frequency. An AND drives its selective branch instead of enumerating the union of every term. Duplicate AST leaves have independent cursors sharing verified data, preserving `(A AND B) OR A`. Block-window bounds are reused until their validity interval ends. Per-document array allocation and recursive AST testing are removed from this path. Complete cached posting lists are shared with the materialized executor; cursors use cached arrays directly.\n')
lines.append('WAND is a literal pivot-based implementation: sort active document cursors, select a pivot using global field-aware score upper bounds, seek earlier cursors when their prefix cannot beat the heap, then apply block-local interval bounds before scoring. Positive Boolean predicates can filter WAND candidates; automatic routing currently selects WAND only for pure disjunctions. Exact-order partial bounds are memoized by term subset so floating-point additions follow the scorer’s original term/body/title order. Equal scores retain input-order ties. At 16 terms, the memo table is at most 512 KiB of query working memory, explicitly included in the existing guard; it adds no serialized index bytes.\n')
lines.append('Automatic routing is intentionally conservative: WAND needs at least two OR terms, summed df ≥ 4,096, max/min df ≥ 2, top-K ≤ 20, a body-enabled field, and fewer than half the posting rows already available as complete cached lists. Small/cached mixed trees use materialized execution; forced Boolean/WAND modes are internal benchmark/library options, never HTTP parameters. The df/caching heuristic was informed by the supplemental OR experiment, then frozen before evaluating the separate 40-query OR set. It is a heuristic, not a learned optimal planner.\n')
lines.append('## Measurement method\nAll measurements use the unchanged 10,000-decision COLD Cases sample and original embedding-training strings from [FREE-LAW-PROJECT.md](FREE-LAW-PROJECT.md). The 160 original held-out queries remain. The WAND experiment adds 21 distinct supplemental OR strings (used to inform routing) and 40 separately seeded OR strings using 2/4/8/16 legal terms. The 40-string set is separate from tuning strings; terms and corpus overlap. This is an artificial stress test, not attorney traffic or relevance evaluation.\n')
lines.append('Five variants share identical encoded bytes: `before` freezes the previous block executor; `recovered` is the repaired executor with materialized execution on supplemental/held-out OR queries; `tree` forces composable Boolean block execution; `wand` forces WAND on eligible positive trees; `auto` uses final routing. Each query/variant runs three shuffled uncached passes and three shuffled mixed-cache passes. Variant order is randomized within query pairs. Cache contexts are separate (4 MiB each); a benchmark process can retain five contexts, unlike a single deployed Worker. Correctness checks, JSON hashing and memory sampling are outside timing. Exhaustive reference results are prepared first, so OS/filesystem/JIT/document validation may be warm. Uncached means no retained SearchRuntime, not a cold isolate or cold R2. Mixed-cache tables use passes 1–2; pass 0 is retained in raw results.\n')
lines.append('## First stage: Boolean recovery before WAND\n')
rows=[]
for budget in [8,48]:
 r=read(f'boolean-boolean-{budget}-mixed.json')
 for phase in ['uncached','mixed-cache']:
  for variant in ['before','recovered','tree']:
   m=metrics(subset(r,'boolean',variant,phase));rows.append([budget,phase,variant,f(m['p50']),f(m['p95'])])
lines.append(table(['MiB','Cache mode','Executor','Boolean P50 ms','Boolean P95 ms'],rows))
lines.append('These first-stage samples predate WAND and remain separate from final measurements. They show recovery without relying on WAND. Forced tree execution is not the best choice for every small list; automatic routing preserves the materialized fast path.\n')
lines.append('## Final matrix: original mixed Boolean workload\n')
rows=[]
for r in configs:
 a=metrics(subset(r,'boolean','before','mixed-cache'));b=metrics(subset(r,'boolean','auto','mixed-cache'))
 rows.append([r['budgetMiB'],r['policy'],f(a['p50'])+' → '+f(b['p50']),f(a['p95'])+' → '+f(b['p95']),f(b['reads']),round(b['bytes']),b['errors']])
lines.append(table(['MiB','Embedding','Warm P50 ms before → auto','Warm P95 ms before → auto','Auto reads/query','Auto bytes/query','Errors'],rows))
lines.append('## WAND: separate 40-query OR set\n')
rows=[]
for r in configs:
 for phase in ['uncached','mixed-cache']:
  a=metrics(subset(r,'wand-heldout','recovered',phase));w=metrics(subset(r,'wand-heldout','wand',phase));b=metrics(subset(r,'wand-heldout','auto',phase))
  rows.append([r['budgetMiB'],r['policy'],phase,f(a['p50'])+' → '+f(b['p50']),f(a['p95'])+' → '+f(b['p95']),round(a['scored']),round(w['scored']),round(b['scored'])])
lines.append(table(['MiB','Embedding','Cache mode','P50 ms recovery → auto','P95 ms recovery → auto','Recovery scored docs','Forced WAND scored docs','Auto scored docs'],rows))
lines.append('WAND reduces scoring work substantially, but it is not uniformly faster on hot caches or very common, similarly frequent terms. Sorting/pivot/bound costs remain, and complete cached arrays can make materialized execution cheaper. The report retains warm-tail regressions and the forced-WAND control; reduced documents scored must not be read as a guaranteed latency reduction. Global maxima are derived from existing directories; no frequency scan is needed to construct them for blocked lists. Small lists compute maxima from their already decoded rows.\n')
lines.append('## Local Worker validation\n')
worker=read('boolean-workerd.json');rows=[]
for r in worker['rows']:
 t=[s['ms'] for s in r['samples']];rows.append([r['budget'],len(t),f(statistics.median(t)),f(pct(t,.95)),f(r['startupWallMs'])])
lines.append(table(['MiB, mixed embedding','Measured HTTP responses','HTTP P50 ms','HTTP P95 ms','Process startup wall ms'],rows))
lines.append('The actual Wrangler-built Worker runs in local workerd/Miniflare using its R2 binding. Thirteen Boolean/OR shapes × three passes × four budgets = 156 timed HTTP responses. An additional 104 untimed HTTP requests compare default/pruned results exactly with exhaustive results within workerd, with assertions that real HTTP routing exercises WAND and Boolean blocks, plus Node ID/score checks (1e-12 cross-runtime tolerance). Startup includes process launch/IPC; this is not deployed Cloudflare latency, startup CPU, or an account-limit test.\n')
lines.append('## Correctness and diagnostics\nTests compare exact top-K IDs/scores for Boolean grouping, repeated leaves, fields, boosts including fractional near-ties, limits 1–100, full-local and full-remote layouts, randomized trees and 16-term WAND subsets. Additional tests ensure pivots skip low-impact documents, selective unions drive AND traversal, and preloaded complete postings support forced execution without storage reads. Total=true remains exact and bypasses top-K-only pruning.\n')
lines.append('New diagnostics identify the executor, ranked/visited documents, logical nonsequential cursor seeks, asynchronous cursor loads, blocks decoded, block-cache hits, complete-posting cache hits, WAND pivots and pivot skips. The pre-WAND/initial trial files use the earlier cursorSeeks counter for asynchronous loads; final files distinguish both. Snapshot `before` lacks the new counters, so its zero-filled diagnostic summary must not be interpreted as zero traversal.\n')
lines.append('## Limits and reproduction\nRemote frequency misses still fetch whole streams to avoid request amplification; WAND primarily saves decoding/scoring CPU and working arrays, not cold R2 bytes. Cache hits can avoid those reads. Mixed trees with OR under AND are routed separately from pure OR WAND; the forced mode is not a recommendation for all Boolean queries. Concurrent isolate working-set peaks, deployed R2, real query logs and larger legal corpora remain unmeasured. Configurations run in fixed order and share a host, so comparisons within randomized pairs are stronger than cross-budget absolute comparisons. Multiple cache contexts and host GC can affect tails; no confidence interval is claimed.\n')
lines.append('```sh\nnpm run check\nnpm test\n# Requires the unchanged FLP generated corpus/index fixtures.\nnode --import tsx bench/boolean-task.ts 8 mixed boolean\nnode --import tsx bench/boolean-task.ts 48 mixed boolean\nnode --import tsx bench/boolean-run.ts\nnode --import tsx bench/boolean-worker.ts\npython3 bench/boolean-report.py\n```\nRaw per-configuration samples are referenced by results/boolean-final.json; the compact index avoids duplicating all samples in a second large file. Aggregate metrics are in results/boolean-summary.json. Initial WAND trials are retained separately. Full index generations and immutable R2 objects are unchanged.\n')
(root/'BOOLEAN-WAND.md').write_text('\n'.join(lines))
