#!/usr/bin/env python3
"""Deterministic two-stage, shard-stratified COLD Cases sampling.
Dependencies: pyarrow==26.0.1 fsspec==2026.9.0 aiohttp==3.14.5.
Reads Parquet footers and one selected row group per shard, not the full dataset.
"""
import argparse,collections,hashlib,json,random,time,urllib.request,pathlib
import fsspec,pyarrow.parquet as pq
REVISION='5d8d0d8457ef63b6463af9737da21d3badd924ad'
REPO='harvard-lil/cold-cases'
def main():
 p=argparse.ArgumentParser();p.add_argument('--count',type=int,default=10000);p.add_argument('--seed',type=int,default=20261111);p.add_argument('--out',default='bench/generated/flp');args=p.parse_args()
 out=pathlib.Path(args.out);out.mkdir(parents=True,exist_ok=True)
 info=json.load(urllib.request.urlopen(f'https://huggingface.co/api/datasets/{REPO}/revision/{REVISION}'))
 names=sorted(x['rfilename'] for x in info['siblings'] if x['rfilename'].endswith('.parquet'))
 fs=fsspec.filesystem('http');inventory=[];started=time.time()
 def open_file(name):return fs.open(f'https://huggingface.co/datasets/{REPO}/resolve/{REVISION}/{name}',block_size=262144)
 for name in names:
  with open_file(name) as f:
   m=pq.ParquetFile(f).metadata
   inventory.append({'file':name,'rows':m.num_rows,'groups':[m.row_group(i).num_rows for i in range(m.num_row_groups)]})
  print(f'footer {len(inventory)}/{len(names)}',flush=True)
 total=sum(x['rows'] for x in inventory);alloc=[args.count*x['rows']//total for x in inventory]
 remainders=sorted(range(len(inventory)),key=lambda i:(-(args.count*inventory[i]['rows']%total),inventory[i]['file']))
 for i in remainders[:args.count-sum(alloc)]:alloc[i]+=1
 rng=random.Random(args.seed);documents=[];selection=[];seen=set();skipped=collections.Counter()
 for shard,number in zip(inventory,alloc):
  if not number:continue
  pick=rng.randrange(shard['rows']);group=0
  while pick>=shard['groups'][group]:pick-=shard['groups'][group];group+=1
  order=rng.sample(range(shard['groups'][group]),shard['groups'][group])
  with open_file(shard['file']) as f:
   table=pq.ParquetFile(f).read_row_group(group,columns=['id','case_name','case_name_full','date_filed','court_type','court_jurisdiction','court_full_name','citations','opinions','precedential_status'])
   accepted=0
   for row in order:
    # Slice before conversion so only sampled full texts become Python strings.
    record=table.slice(row,1).to_pylist()[0]
    texts=[o['opinion_text'] for o in record['opinions'] or [] if o.get('opinion_text') and o['opinion_text'].strip()]
    if not texts:skipped['empty_text']+=1;continue
    cid=record['id']
    if cid in seen:skipped['duplicate_cluster_id']+=1;continue
    seen.add(cid)
    doc={'id':f'courtlistener:{cid}','title':record['case_name'] or record['case_name_full'] or '', 'body':'\n\n'.join(texts),'metadata':{'cluster_id':cid,'date_filed':str(record['date_filed']) if record['date_filed'] else None,'court':record['court_full_name'],'court_type':record['court_type'],'jurisdiction':record['court_jurisdiction'],'citations':record['citations'],'precedential_status':record['precedential_status'],'opinion_ids':[o['opinion_id'] for o in record['opinions'] or []],'url':f'https://www.courtlistener.com/opinion/{cid}/'}}
    documents.append(doc);selection.append({'id':doc['id'],'file':shard['file'],'row_group':group,'row_in_group':row});accepted+=1
    if accepted==number:break
   del table
  if accepted!=number:raise RuntimeError('Not enough eligible rows in selected group')
  print(f'sampled {len(documents)}/{args.count}: {shard["file"]} group {group}',flush=True)
 # Shuffle serving IDs: do not expose shard/group ordering to compression/pruning.
 pairs=list(zip(documents,selection));rng.shuffle(pairs)
 corpus=out/'corpus.jsonl'
 with corpus.open('w',encoding='utf8',newline='\n') as f:
  for doc,_ in pairs:f.write(json.dumps(doc,ensure_ascii=False,separators=(',',':'))+'\n')
 digest=hashlib.sha256(corpus.read_bytes()).hexdigest()
 manifest={'source':f'https://huggingface.co/datasets/{REPO}','revision':REVISION,'seed':args.seed,'documents':len(documents),'source_rows':total,'sampling':'Allocate by shard row counts (largest remainder); select one row group per shard with probability proportional to rows; uniformly shuffle rows within that group and accept nonempty, distinct cluster IDs. This is a two-stage cluster sample, not independent uniform sampling. Shuffle final document order. No text truncation, length filtering, or rewriting. One document per decision, concatenating its opinions with two newlines.','bytes':corpus.stat().st_size,'sha256':digest,'skipped':dict(skipped),'elapsedSeconds':time.time()-started,'inventory':inventory,'selection':[s for _,s in pairs]}
 (out/'sample-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 print(json.dumps({k:v for k,v in manifest.items() if k not in ('inventory','selection')}),flush=True)
if __name__=='__main__':main()
