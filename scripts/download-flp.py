#!/usr/bin/env python3
"""Resumable, ETag-pinned ranged download into one file; bounded buffers, no second copy."""
import argparse,concurrent.futures,json,os,pathlib,threading,time,urllib.request
p=argparse.ArgumentParser();p.add_argument('url');p.add_argument('output');p.add_argument('--workers',type=int,default=8);a=p.parse_args();out=pathlib.Path(a.output);out.parent.mkdir(parents=True,exist_ok=True);checkpoint=out.with_suffix(out.suffix+'.download.json')
head=urllib.request.urlopen(urllib.request.Request(a.url,method='HEAD'));size=int(head.headers['Content-Length']);etag=head.headers['ETag'];step=64*1048576;lock=threading.Lock();started=time.time()
if checkpoint.exists():
 state=json.loads(checkpoint.read_text());assert state['url']==a.url and state['size']==size and state['etag']==etag,'Download source changed'
else:state={'url':a.url,'size':size,'etag':etag,'prefix':out.stat().st_size if out.exists() else 0,'done':[],'complete':False}
def save():
 tmp=checkpoint.with_suffix('.tmp');tmp.write_text(json.dumps(state));tmp.replace(checkpoint)
save();fd=os.open(out,os.O_CREAT|os.O_RDWR,0o600);os.ftruncate(fd,size)
def fetch(start):
 end=min(start+step,size);last=None
 for attempt in range(6):
  try:
   req=urllib.request.Request(a.url,headers={'Range':f'bytes={start}-{end-1}','If-Match':etag})
   with urllib.request.urlopen(req,timeout=120) as r:
    if r.status!=206 or not r.headers.get('Content-Range','').startswith(f'bytes {start}-'):raise RuntimeError('Server ignored requested range')
    offset=start
    while offset<end:
     b=r.read(min(262144,end-offset))
     if not b:raise RuntimeError('Truncated range')
     written=0
     while written<len(b):written+=os.pwrite(fd,b[written:],offset+written)
     offset+=len(b)
   with lock:state['done'].append(start);save()
   return
  except Exception as e:last=e;time.sleep(min(30,2**attempt))
 raise last
try:
 tasks=[i for i in range(state['prefix'],size,step) if i not in set(state['done'])]
 with concurrent.futures.ThreadPoolExecutor(a.workers) as pool:
  futures=[pool.submit(fetch,i) for i in tasks]
  for f in concurrent.futures.as_completed(futures):
   f.result();done=state['prefix']+sum(min(step,size-i) for i in state['done']);print(json.dumps({'bytes':done,'total':size,'percent':round(done/size*100,2),'MiBps':round((done-state['prefix'])/1048576/max(1,time.time()-started),2)}),flush=True)
 os.fsync(fd);state['complete']=True;save()
finally:os.close(fd)
