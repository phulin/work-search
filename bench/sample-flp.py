#!/usr/bin/env python3
"""Pinned two-stage COLD Cases sample, with bounded memory and shard checkpoints.
Dependencies: bench/flp-requirements.txt. One selected row group per source shard.
"""
import argparse,collections,hashlib,json,os,pathlib,random,time,urllib.request
import fsspec,pyarrow.parquet as pq
REVISION='5d8d0d8457ef63b6463af9737da21d3badd924ad'
REPO='harvard-lil/cold-cases'
def sha_file(path):
 h=hashlib.sha256()
 with open(path,'rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
def main():
 p=argparse.ArgumentParser();p.add_argument('--count',type=int,default=10000);p.add_argument('--seed',type=int,default=20261111);p.add_argument('--out',default='bench/generated/flp');args=p.parse_args()
 if args.count<1:raise ValueError('count must be positive')
 out=pathlib.Path(args.out);out.mkdir(parents=True,exist_ok=True);parts=out/'sample-parts';parts.mkdir(exist_ok=True)
 info=json.load(urllib.request.urlopen(f'https://huggingface.co/api/datasets/{REPO}/revision/{REVISION}'))
 names=sorted(x['rfilename'] for x in info['siblings'] if x['rfilename'].endswith('.parquet'))
 fs=fsspec.filesystem('http');inventory=[];started=time.time()
 def open_file(name):return fs.open(f'https://huggingface.co/datasets/{REPO}/resolve/{REVISION}/{name}',block_size=262144)
 for name in names:
  with open_file(name) as f:
   m=pq.ParquetFile(f).metadata
   inventory.append({'file':name,'rows':m.num_rows,'groups':[m.row_group(i).num_rows for i in range(m.num_row_groups)]})
  print(f'footer {len(inventory)}/{len(names)}',flush=True)
 total=sum(x['rows'] for x in inventory)
 if args.count>total:raise ValueError('count exceeds source rows')
 alloc=[args.count*x['rows']//total for x in inventory]
 remainders=sorted(range(len(inventory)),key=lambda i:(-(args.count*inventory[i]['rows']%total),inventory[i]['file']))
 for i in remainders[:args.count-sum(alloc)]:alloc[i]+=1
 rng=random.Random(args.seed);addresses=[];seen=set();skipped=collections.Counter();part_files=[]
 for shard_index,(shard,number) in enumerate(zip(inventory,alloc)):
  if not number:continue
  pick=rng.randrange(shard['rows']);group=0
  while pick>=shard['groups'][group]:pick-=shard['groups'][group];group+=1
  order=rng.sample(range(shard['groups'][group]),shard['groups'][group])
  if number>len(order):raise ValueError('Quota exceeds selected row group; reduce count or implement multiple row-group sampling')
  part=parts/f'{shard_index:02}-{args.count}-{args.seed}-{REVISION[:12]}.jsonl';meta=part.with_suffix('.json')
  identity={'revision':REVISION,'seed':args.seed,'count':args.count,'file':shard['file'],'group':group,'quota':number}
  if part.exists() and meta.exists():
   saved=json.loads(meta.read_text())
   if saved['identity']!=identity or sha_file(part)!=saved['sha256']:raise ValueError('Invalid sample checkpoint')
   rows=saved['rows'];skipped.update(saved['skipped'])
   if any(r['selection']['id'] in seen for r in rows):raise ValueError('Duplicate ID in sample checkpoint')
   seen.update(r['selection']['id'] for r in rows)
  else:
   rows=[];local_skipped=collections.Counter();offset=0;temporary=part.with_suffix('.tmp')
   with open_file(shard['file']) as f,temporary.open('wb') as output:
    table=pq.ParquetFile(f).read_row_group(group,columns=['id','case_name','case_name_full','date_filed','court_type','court_jurisdiction','court_full_name','citations','opinions','precedential_status'])
    for row in order:
     record=table.slice(row,1).to_pylist()[0]
     texts=[o['opinion_text'] for o in record['opinions'] or [] if o.get('opinion_text') and o['opinion_text'].strip()]
     if not texts:local_skipped['empty_text']+=1;continue
     cid=record['id'];external=f'courtlistener:{cid}'
     if external in seen:local_skipped['duplicate_cluster_id']+=1;continue
     seen.add(external)
     doc={'id':external,'title':record['case_name'] or record['case_name_full'] or '', 'body':'\n\n'.join(texts),'metadata':{'cluster_id':cid,'date_filed':str(record['date_filed']) if record['date_filed'] else None,'court':record['court_full_name'],'court_type':record['court_type'],'jurisdiction':record['court_jurisdiction'],'citations':record['citations'],'precedential_status':record['precedential_status'],'opinion_ids':[o['opinion_id'] for o in record['opinions'] or []],'url':f'https://www.courtlistener.com/opinion/{cid}/'}}
     data=(json.dumps(doc,ensure_ascii=False,separators=(',',':'))+'\n').encode('utf8');output.write(data)
     rows.append({'offset':offset,'length':len(data),'selection':{'id':external,'file':shard['file'],'row_group':group,'row_in_group':row}});offset+=len(data)
     if len(rows)==number:break
    del table
   if len(rows)!=number:raise RuntimeError('Not enough eligible rows in selected group')
   temporary.replace(part);saved={'identity':identity,'sha256':sha_file(part),'rows':rows,'skipped':dict(local_skipped)}
   meta.write_text(json.dumps(saved,separators=(',',':')));skipped.update(local_skipped)
  if len(rows)!=number:raise ValueError('Sample checkpoint quota mismatch')
  for row in rows:addresses.append({'part':len(part_files),**row})
  part_files.append(part)
  print(f'sampled {len(addresses)}/{args.count}: {shard["file"]} group {group}',flush=True)
 # Shuffle row references rather than retaining all full texts in RAM. The RNG
 # operations and JSON bytes match the original sampler for the same count/seed.
 if len(addresses)!=args.count:raise ValueError('Incomplete sample')
 rng.shuffle(addresses);corpus=out/'corpus.jsonl';digest=hashlib.sha256();fds=[]
 try:
  fds=[os.open(part,os.O_RDONLY) for part in part_files]
  with corpus.open('wb') as output:
   for ref in addresses:
    data=os.pread(fds[ref['part']],ref['length'],ref['offset'])
    if len(data)!=ref['length']:raise RuntimeError('Truncated sample checkpoint')
    output.write(data);digest.update(data)
 finally:
  for fd in fds:os.close(fd)
 manifest={'source':f'https://huggingface.co/datasets/{REPO}','revision':REVISION,'seed':args.seed,'documents':len(addresses),'source_rows':total,'sampling':'Allocate by shard row counts (largest remainder); select one row group per shard with probability proportional to rows; uniformly shuffle rows within that group and accept nonempty, distinct cluster IDs. This is a two-stage cluster sample, not independent uniform sampling. Shuffle final document order. No text truncation, length filtering, or rewriting. One document per decision, concatenating its opinions with two newlines.','bytes':corpus.stat().st_size,'sha256':digest.hexdigest(),'skipped':dict(skipped),'elapsedSeconds':time.time()-started,'inventory':inventory,'selection':[r['selection'] for r in addresses]}
 (out/'sample-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 print(json.dumps({k:v for k,v in manifest.items() if k not in ('inventory','selection')}),flush=True)
if __name__=='__main__':main()
