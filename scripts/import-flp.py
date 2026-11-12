#!/usr/bin/env python3
"""Official full snapshot -> metadata SQLite + bounded durable JSONL batches. No sampling."""
import argparse,bz2,csv,hashlib,html,html.parser,json,pathlib,sqlite3,sys,time,shutil,io,os
from flp_text import caption
csv.field_size_limit(sys.maxsize)
p=argparse.ArgumentParser();p.add_argument('--root',default='work/full-flp');p.add_argument('--metadata',action='store_true');p.add_argument('--batch-docs',type=int,default=50000);p.add_argument('--decoder-threads',type=int,default=4);p.add_argument('--batch-mib',type=int,default=512);a=p.parse_args();root=pathlib.Path(a.root);root.mkdir(parents=True,exist_ok=True);queue=root/'queue';queue.mkdir(exist_ok=True);batches=root/'batches';batches.mkdir(exist_ok=True)
def atomic(path,data):
 tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(data));tmp.replace(path)
def complete(file):return json.loads(file.with_suffix(file.suffix+'.download.json').read_text())['complete']
class DownloadStream(io.RawIOBase):
 def __init__(self,file):self.file=file;self.fd=os.open(file,os.O_RDONLY);self.pos=0;self.frontier=0;self.size=0
 def readable(self):return True
 def readinto(self,b):
  while self.pos>=self.frontier:
   state=json.loads(self.file.with_suffix(self.file.suffix+'.download.json').read_text());self.size=state['size'];self.frontier=state['prefix'];done=set(state['done'])
   while self.frontier in done:self.frontier=min(self.size,self.frontier+64*1048576)
   if self.pos>=self.size:return 0
   if self.pos>=self.frontier:time.sleep(1)
  data=os.pread(self.fd,min(len(b),self.frontier-self.pos),self.pos);b[:len(data)]=data;self.pos+=len(data);return len(data)
 def close(self):
  if not self.closed:os.close(self.fd)
  super().close()
def rows(name):
 file=root/(name+'-2026-09-30.csv.bz2')
 if complete(file):
  try:
   import indexed_bzip2
   source=io.BufferedReader(indexed_bzip2.IndexedBzip2File(str(file),parallelization=a.decoder_threads),buffer_size=524288)
   return csv.DictReader(io.TextIOWrapper(source,encoding='utf8',newline=''),escapechar='\\')
  except ImportError:source=open(file,'rb')
 else:source=DownloadStream(file)
 return csv.DictReader(io.TextIOWrapper(bz2.BZ2File(source,'r'),encoding='utf8',newline=''),escapechar='\\')

db=sqlite3.connect(root/'metadata.sqlite');db.execute('PRAGMA journal_mode=WAL');db.execute('CREATE TABLE IF NOT EXISTS cases (id INTEGER PRIMARY KEY,title TEXT,date TEXT,status TEXT)')
if a.metadata:
 checkpoint=root/'metadata-progress.json';previous=json.loads(checkpoint.read_text()).get('rows',0) if checkpoint.exists() else 0;count=0
 for count,row in enumerate(rows('opinion-clusters'),1):
  if count<=previous:continue
  title=caption(row);db.execute('INSERT OR REPLACE INTO cases VALUES (?,?,?,?)',(int(row['id']),title,row['date_filed'],row['precedential_status']))
  if count%10000==0:db.commit();atomic(checkpoint,{'rows':count,'complete':False});print('metadata',count,flush=True)
 db.commit();atomic(checkpoint,{'rows':count,'complete':True});print('metadata complete',count,flush=True);sys.exit(0)
if not json.loads((root/'metadata-progress.json').read_text())['complete']:raise RuntimeError('Metadata not complete')
from flp_text import body
previous=sorted(batches.glob('*.json'));last=json.loads(previous[-1].read_text()) if previous else {};skip=last.get('endRow',0);part=last.get('part',-1)+1;emitted=last.get('emittedTotal',0);skipped=last.get('skippedTotal',0);output=None;count=0;digest=None;size=0;startRow=skip+1
for rowNumber,row in enumerate(rows('opinions'),1):
 if rowNumber<=skip:continue
 if output is None:
  while len(list(queue.glob('*.jsonl')))>=5 or shutil.disk_usage(root).free<8*1024**3:time.sleep(5)
  path=queue/f'{part:05}.jsonl';temporary=path.with_suffix('.tmp');output=temporary.open('wb');count=0;size=0;digest=hashlib.sha256();startRow=rowNumber
 text,field=body(row)
 if text is None:skipped+=1
 else:
  cid=int(row['cluster_id']);case=db.execute('SELECT title,date,status FROM cases WHERE id=?',(cid,)).fetchone();opinion=int(row['id'])
  doc={'id':f'courtlistener-opinion:{opinion}','title':case[0] if case else f'Opinion {opinion}','body':text,'metadata':{'opinion_id':opinion,'cluster_id':cid,'date_filed':case[1] if case else None,'precedential_status':case[2] if case else None,'text_field':field,'url':f'https://www.courtlistener.com/opinion/{cid}/','snapshot':'2026-09-30'}}
  data=(json.dumps(doc,ensure_ascii=False,separators=(',',':'))+'\n').encode();output.write(data);digest.update(data);size+=len(data);count+=1;emitted+=1
 if count>=a.batch_docs or size>=a.batch_mib*1048576:
  output.close();temporary.replace(path);atomic(batches/f'{part:05}.json',{'part':part,'startRow':startRow,'endRow':rowNumber,'documents':count,'bytes':size,'sha256':digest.hexdigest(),'emittedTotal':emitted,'skippedTotal':skipped,'complete':False});print('published',part,count,emitted,flush=True);part+=1;output=None
if output:
 output.close();temporary.replace(path);atomic(batches/f'{part:05}.json',{'part':part,'startRow':startRow,'endRow':rowNumber,'documents':count,'bytes':size,'sha256':digest.hexdigest(),'emittedTotal':emitted,'skippedTotal':skipped,'complete':False})
atomic(root/'import-complete.json',{'rows':rowNumber,'documents':emitted,'skippedEmptyText':skipped,'snapshot':'2026-09-30','complete':True});print('import complete',emitted,flush=True)
