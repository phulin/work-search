#!/usr/bin/env python3
"""Join official cluster/docket/court/citation snapshots without modifying index inputs."""
import argparse, bz2, csv, gzip, hashlib, io, json, pathlib, sqlite3, struct, sys, zlib
from flp_text import caption
try:
    import indexed_bzip2
except ImportError:
    indexed_bzip2 = None

csv.field_size_limit(sys.maxsize)
parser = argparse.ArgumentParser()
parser.add_argument('--root', default='work/full-flp')
args = parser.parse_args()
root = pathlib.Path(args.root)
out = root / 'case-metadata'
out.mkdir(exist_ok=True)
db = sqlite3.connect(root / 'case-metadata.sqlite')
db.executescript('''PRAGMA journal_mode=WAL; PRAGMA cache_size=-65536;
CREATE TABLE IF NOT EXISTS progress (stage TEXT PRIMARY KEY, rows INTEGER, done INTEGER);
CREATE TABLE IF NOT EXISTS cases (id INTEGER PRIMARY KEY,docket INTEGER,title TEXT,full_title TEXT,date TEXT,status TEXT,judges TEXT,cited_by INTEGER,approx INTEGER);
CREATE TABLE IF NOT EXISTS dockets (id INTEGER PRIMARY KEY,court TEXT,number TEXT,title TEXT,full_title TEXT);
CREATE TABLE IF NOT EXISTS citations (cluster INTEGER,volume TEXT,reporter TEXT,page TEXT);
''')

def clean(value):
    value = (value or '').strip()
    return '' if value in ('\\N', 'N', 'null', 'None') else value

def rows(name):
    path = root / (name + '-2026-09-30.csv.bz2')
    checkpoint = json.loads(path.with_suffix(path.suffix + '.download.json').read_text())
    if not checkpoint['complete']: raise RuntimeError(name + ' download incomplete')
    source = indexed_bzip2.IndexedBzip2File(str(path), parallelization=2) if indexed_bzip2 else bz2.BZ2File(path)
    return csv.DictReader(io.TextIOWrapper(io.BufferedReader(source, buffer_size=524288), encoding='utf8', newline=''), escapechar='\\')

def stage(name, source, consume):
    previous = db.execute('SELECT rows,done FROM progress WHERE stage=?', (name,)).fetchone()
    if previous and previous[1]: return
    skip = previous[0] if previous else 0
    n = 0
    for n, row in enumerate(source, 1):
        if n <= skip: continue
        consume(row)
        if n % 100000 == 0:
            db.execute('INSERT OR REPLACE INTO progress VALUES (?,?,0)', (name,n)); db.commit()
            print(name,n,flush=True)
    db.execute('INSERT OR REPLACE INTO progress VALUES (?,?,1)', (name,n)); db.commit()
    print(name,'complete',n,flush=True)

def cluster(r):
    title = caption(r)
    db.execute('INSERT OR REPLACE INTO cases VALUES (?,?,?,?,?,?,?,?,?)', (
        int(r['id']), int(r['docket_id']) if clean(r['docket_id']) else None,
        title, clean(r['case_name_full']), clean(r['date_filed']), clean(r['precedential_status']),
        clean(r['judges']), int(r['citation_count'] or 0), r['date_filed_is_approximate']=='t'))

stage('clusters', rows('opinion-clusters'), cluster)
db.execute('CREATE INDEX IF NOT EXISTS case_docket ON cases(docket)'); db.commit()

# A 16-MiB Bloom filter avoids disk lookups for unrelated RECAP-only dockets.
bits = bytearray(1 << 24); mask = (1 << 27)-1
def hashes(n): return ((n * 2654435761) & mask, ((n ^ (n >> 16)) * 2246822519) & mask)
for (n,) in db.execute('SELECT DISTINCT docket FROM cases WHERE docket IS NOT NULL'):
    for h in hashes(n): bits[h >> 3] |= 1 << (h & 7)
def docket(r):
    n = int(r['id'])
    if not all(bits[h >> 3] & (1 << (h & 7)) for h in hashes(n)): return
    if not db.execute('SELECT 1 FROM cases WHERE docket=? LIMIT 1', (n,)).fetchone(): return
    db.execute('INSERT OR REPLACE INTO dockets VALUES (?,?,?,?,?)', (
        n, clean(r['court_id']), clean(r['docket_number']),
        caption(r), clean(r['case_name_full'])))

stage('dockets', rows('dockets'), docket)
stage('citations', rows('citations'), lambda r: db.execute('INSERT INTO citations VALUES (?,?,?,?)',
    (int(r['cluster_id']),clean(r['volume']),clean(r['reporter']),clean(r['page']))))
db.execute('CREATE INDEX IF NOT EXISTS citation_cluster ON citations(cluster)'); db.commit()
courts = {r['id']: {k:clean(r[k]) for k in ['full_name','short_name','citation_string','jurisdiction']} for r in rows('courts')}
(out / 'courts.json').write_text(json.dumps(courts))

maximum, count = db.execute('SELECT max(id),count(*) FROM cases').fetchone()
catalog = open(out / 'casemap-0.bin','w+b'); catalog.truncate((maximum+1)*16)
object_id = 0; offset = 0; payload = open(out / 'cases-0.bin','wb')
names = ['casemap-0.bin','cases-0.bin']; stats = dict(cases=count, missingCaption=0, missingCourt=0, recoveredCaption=0)
pending=[];pending_bytes=0
def flush():
    global payload,object_id,offset,pending,pending_bytes
    if not pending:return
    b=gzip.compress(b'['+b','.join(b for _,b in pending)+b']',compresslevel=1,mtime=0)
    if offset and offset+len(b)>64*1048576:
        payload.close();object_id+=1;offset=0;name=f'cases-{object_id}.bin';names.append(name);payload=open(out/name,'wb')
    pointer=struct.pack('<IIII',object_id,offset,len(b),zlib.crc32(b))
    for cid,_ in pending:catalog.seek(cid*16);catalog.write(pointer)
    payload.write(b);offset+=len(b);pending=[];pending_bytes=0
sql = '''SELECT c.*,d.court,d.number,d.title,d.full_title FROM cases c LEFT JOIN dockets d ON c.docket=d.id ORDER BY c.id'''
for n,r in enumerate(db.execute(sql),1):
    cid,did,title,full,date,status,judges,cited,approx,court,number,dtitle,dfull = r
    caption = title or dtitle or full or dfull or ''
    if not caption: stats['missingCaption'] += 1
    if not title and caption: stats['recoveredCaption'] += 1
    if not court: stats['missingCourt'] += 1
    citations = list(dict.fromkeys(' '.join(x for x in c if x) for c in db.execute(
        'SELECT volume,reporter,page FROM citations WHERE cluster=? ORDER BY reporter,volume,page', (cid,))))
    data = {'cluster_id':cid,'title':caption,'case_name_full':full or dfull or caption,
        'docket_id':did,'docket_number':number,'court_id':court,'court':courts.get(court),
        'date_filed':date,'date_filed_is_approximate':bool(approx),'precedential_status':status,
        'judges':judges,'citation_count':cited,'citations':citations,'snapshot':'2026-09-30'}
    b = json.dumps(data,ensure_ascii=False,separators=(',',':')).encode()
    if len(b)>1048574:raise RuntimeError('Case metadata exceeds decoder limit')
    if pending_bytes+len(b)+len(pending)+2>256*1024:flush()
    pending.append((cid,b));pending_bytes+=len(b)
    if len(pending)>=256:flush()
    if n%100000==0: print('pack',n,flush=True)
flush();payload.close();catalog.close()
# Bound every catalog object to 64 MiB, including uploads through the Worker.
catalog_path=out/'casemap-0.bin'
if catalog_path.stat().st_size>64*1048576:
    with open(catalog_path,'rb') as source:
        page=0
        while block:=source.read(64*1048576):
            name=f'casemap-{page}.bin'
            with open(out/(name+'.tmp'),'wb') as target:target.write(block)
            if page:names.append(name)
            page+=1
    for page in range(page):
        name=f'casemap-{page}.bin';(out/(name+'.tmp')).replace(out/name)
objects=[]
for name in names:
    digest=hashlib.sha256()
    with open(out/name,'rb') as f:
        while b:=f.read(1048576):digest.update(b)
    objects.append(dict(name=name,size=(out/name).stat().st_size,sha256=digest.hexdigest()))
generation=hashlib.sha256(json.dumps(objects,sort_keys=True).encode()).hexdigest()
manifest=dict(version=2,encoding='gzip-json-blocks',generation=generation,maxId=maximum,recordBytes=16,objects=objects,statistics=stats)
(out/'manifest.tmp').write_text(json.dumps(manifest,indent=2));(out/'manifest.tmp').replace(out/'manifest.json')
print('packed',json.dumps(manifest['statistics']),flush=True)
