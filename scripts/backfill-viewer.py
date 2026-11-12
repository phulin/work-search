#!/usr/bin/env python3
import argparse,csv,io,json,pathlib,sqlite3,sys,time,hashlib
import indexed_bzip2
from flp_text import body
csv.field_size_limit(sys.maxsize)
p=argparse.ArgumentParser();p.add_argument('--root',default='work/full-flp');a=p.parse_args();root=pathlib.Path(a.root);queue=root/'viewer-queue';queue.mkdir(exist_ok=True);jobs=root/'viewer-jobs';jobs.mkdir(exist_ok=True)
# Capture existing batches; later builders already pack full text themselves.
targets=root/'viewer-targets.json'
if targets.exists():parts=json.loads(targets.read_text())
else:
 parts=[json.loads(p.read_text()) for p in sorted((root/'batches').glob('*.json'))];targets.write_text(json.dumps(parts))
db=sqlite3.connect(root/'metadata.sqlite');part=0;output=None;digest=None;count=0
stream=io.TextIOWrapper(io.BufferedReader(indexed_bzip2.IndexedBzip2File(str(root/'opinions-2026-09-30.csv.bz2'),parallelization=2),buffer_size=524288),encoding='utf8',newline='')
for number,row in enumerate(csv.DictReader(stream,escapechar='\\'),1):
 if part>=len(parts):break
 job=parts[part]
 if number<job['startRow']:continue
 done=(jobs/f'{job["part"]:05}.processed').exists()
 if not done:
  if output is None:
   while len(list(queue.glob('*.jsonl')))>=2:time.sleep(2)
   target=queue/f'{job["part"]:05}.jsonl';temporary=target.with_suffix('.tmp');output=temporary.open('wb');count=0;digest=hashlib.sha256()
  text,field=body(row)
  if text is not None:
   cid=int(row['cluster_id']);case=db.execute('SELECT title,date,status FROM cases WHERE id=?',(cid,)).fetchone();oid=int(row['id']);doc={'id':f'courtlistener-opinion:{oid}','title':case[0] if case else f'Opinion {oid}','body':text,'metadata':{'opinion_id':oid,'cluster_id':cid,'date_filed':case[1] if case else None,'precedential_status':case[2] if case else None,'text_field':field,'url':f'https://www.courtlistener.com/opinion/{cid}/','snapshot':'2026-09-30'}};data=(json.dumps(doc,ensure_ascii=False,separators=(',',':'))+'\n').encode();output.write(data);digest.update(data);count+=1
 if number==job['endRow']:
  if output:
   output.close();assert count==job['documents'],'Backfill document count mismatch';assert digest.hexdigest()==job['sha256'],'Backfill differs from indexed source';temporary.replace(target);checkpoint=jobs/f'{job["part"]:05}.json';tmp=checkpoint.with_suffix('.tmp');tmp.write_text(json.dumps(job));tmp.replace(checkpoint);output=None;print('viewer batch',job['part'],count,flush=True)
  part+=1
(root/'viewer-backfill-complete.json').write_text(json.dumps({'batches':len(parts),'complete':True}));print('viewer backfill extraction complete',flush=True)
