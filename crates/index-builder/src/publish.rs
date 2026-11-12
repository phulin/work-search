use crate::{util::*,format::*,ingest::{Run,run_dir},finalize::Finalized,merge::RecordCursor};
use std::{fs::{File,self},io::{Read,Write,Seek,SeekFrom},path::{Path,PathBuf},collections::{HashMap,BinaryHeap,BTreeMap},cmp::Reverse};
use sha2::{Digest,Sha256};
pub fn objects(out:&Path,runs:&[Run],finals:&[Finalized])->Result<(Vec<Object>,Vec<u32>)> {
    let mut objects=Vec::new();let mut bases=Vec::new();fs::create_dir_all(out.join("packs"))?;
    for (run,done) in runs.iter().zip(finals) {
        let base:u32=objects.len().try_into()?;bases.push(base);let dir=run_dir(out,run.id);let mut src=reader(&dir.join("documents.final"))?;
        let mut patches:HashMap<u32,Vec<(u32,u32)>>=HashMap::new();let mut opened=HashMap::new();
        for _ in 0..run.count {let mut loc=[0u8;36];src.read_exact(&mut loc)?;let fr=[at_u32(&loc,12),at_u32(&loc,16),at_u32(&loc,20)];if let std::collections::hash_map::Entry::Vacant(e)=opened.entry(fr[0]){e.insert(File::open(dir.join(format!("packs/plan-{}.bin",fr[0])))?);}let f=opened.get_mut(&fr[0]).unwrap();f.seek(SeekFrom::Start(fr[1] as u64))?;let b=read_bytes(f,fr[2] as usize)?;
            if b.len()%32!=0{return Err("bad staged forward directory".into())}let patch=patches.entry(fr[0]).or_default();for at in (0..b.len()).step_by(32){for off in [8,20]{patch.push((fr[1]+(at+off) as u32,at_u32(&b,at+off).checked_add(base).ok_or("object overflow")?));}}
        }
        drop(opened);
        for (i,old) in done.objects.iter().enumerate() {
            let number=base+i as u32;let name=format!("plan-{number}.bin");let mut r=reader(&dir.join("packs").join(&old.name))?;let mut w=writer(&out.join("packs").join(&name))?;let mut hash=Sha256::new();let mut crcs=Vec::new();let mut at=0u64;let mut buffer=vec![0;PAGE];let mut patch=patches.remove(&(i as u32)).unwrap_or_default();patch.sort_unstable_by_key(|p|p.0);let mut pi=0;
            while at<old.size {let len=(old.size-at).min(PAGE as u64) as usize;r.read_exact(&mut buffer[..len])?;while pi<patch.len() && (patch[pi].0 as u64)<at+len as u64 {let(offset,value)=patch[pi];if (offset as u64)<at || offset as u64+4>at+len as u64{return Err("unaligned forward patch".into())}buffer[offset as usize-at as usize..offset as usize-at as usize+4].copy_from_slice(&value.to_le_bytes());pi+=1;}hash.update(&buffer[..len]);crcs.push(crc32fast::hash(&buffer[..len]));w.write_all(&buffer[..len])?;at+=len as u64;}if pi!=patch.len(){return Err("out-of-range forward patch".into())}w.flush()?;
            objects.push(Object{name,size:old.size,sha256:hex(&hash.finalize()),checksums:crcs});
        }
    }Ok((objects,bases))
}
fn relocate_header(h:&mut[u8;80],base:u32)->Result<()> {for at in [32,44,56]{let n=at_u32(h,at).checked_add(base).ok_or("object overflow")?;h[at..at+4].copy_from_slice(&n.to_le_bytes());}Ok(())}
fn merge_ready(paths:&[PathBuf],bases:&[u32],dest:&Path)->Result<()> {let mut cs=paths.iter().map(|p|RecordCursor::open(p)).collect::<Result<Vec<_>>>()?;let mut heap=BinaryHeap::new();for(i,c)in cs.iter().enumerate(){if c.valid{heap.push(Reverse((c.key(),i)));}}let mut w=writer(dest)?;while let Some(Reverse((_,i)))=heap.pop(){relocate_header(&mut cs[i].header,bases[i])?;cs[i].write(&mut w)?;cs[i].advance()?;if cs[i].valid{heap.push(Reverse((cs[i].key(),i)));}}w.flush()?;Ok(())}
#[derive(Clone)]struct LeafRow{doc:u32,bf:u32,tf:u32,b:f64,t:f64,loc:[u8;36]}
struct Leaf {rows:Vec<LeafRow>,positions:Vec<u8>,offsets:Vec<u32>}
impl Leaf {
    fn new()->Self{Self{rows:Vec::with_capacity(BLOCK),positions:Vec::new(),offsets:vec![0]}}
    fn push(&mut self,c:&RecordCursor)->Result<()> {let h=&c.header;let body_len=at_u32(h,72);let mut loc=[0;36];loc.copy_from_slice(&h[32..68]);self.rows.push(LeafRow{doc:at_u32(h,4),bf:at_u32(h,8),tf:at_u32(h,12),b:at_f64(h,16),t:at_f64(h,24),loc});self.positions.extend_from_slice(&body_len.to_le_bytes());self.positions.extend_from_slice(&c.positions);self.offsets.push(self.positions.len().try_into()?);Ok(())}
    fn flush(&mut self,tree:&mut Tree,p:&mut Packer)->Result<()> {if self.rows.is_empty(){return Ok(())}
        let mut positions=words(&[self.rows.len() as u32]);positions.extend_from_slice(&words(&self.offsets));positions.extend_from_slice(&self.positions);let pos=p.put(&positions)?;
        let mut locators=Vec::with_capacity(self.rows.len()*36);for r in &self.rows{locators.extend_from_slice(&r.loc);}let loc=p.put(&locators)?;
        let docs:Vec<_>=self.rows.iter().map(|r|r.doc).collect();let bfs:Vec<_>=self.rows.iter().map(|r|r.bf).collect();let tfs:Vec<_>=self.rows.iter().map(|r|r.tf).collect();let mut bs=Vec::with_capacity(self.rows.len()*8);let mut ts=Vec::with_capacity(self.rows.len()*8);for r in &self.rows{bs.extend_from_slice(&r.b.to_le_bytes());ts.extend_from_slice(&r.t.to_le_bytes());}
        let columns=[pack(&docs,true),pack(&bfs,false),pack(&tfs,false),bs,ts];let mut scores=words(&columns.iter().map(|c|c.len() as u32).collect::<Vec<_>>());for c in columns{scores.extend_from_slice(&c);}let score=p.put(&scores)?;
        tree.push(Branch{first:self.rows[0].doc,last:self.rows.last().unwrap().doc,count:self.rows.len() as u32,height:0,b:self.rows.iter().map(|r|r.b).fold(0.0,f64::max),t:self.rows.iter().map(|r|r.t).fold(0.0,f64::max),score,positions:pos,locators:loc},p)?;
        self.rows.clear();self.positions.clear();self.offsets.clear();self.offsets.push(0);Ok(())
    }
}
pub fn emit(out:&Path,runs:&[Run],bases:&[u32],objects:&mut Vec<Object>,count:u32,averages:(f64,f64),corpus_hash:&str,generation:&str)->Result<Root> {
    let paths:Vec<_>=runs.iter().map(|r|run_dir(out,r.id).join("postings.final")).collect();let dir=out.join("staging/merge");let(mut paths,mut input_bases)=if paths.len()>48 {let mut ps=Vec::new();for (i,g) in paths.chunks(48).enumerate(){let dest=dir.join(format!("ready-{i}.bin"));merge_ready(g,&bases[i*48..i*48+g.len()],&dest)?;ps.push(dest);}let ps=crate::merge::bounded_records(ps,out)?;let n=ps.len();(ps,vec![0;n])}else{(paths,bases.to_vec())};
    let mut cs=paths.iter().map(|p|RecordCursor::open(p)).collect::<Result<Vec<_>>>()?;let mut heap=BinaryHeap::new();for(i,c)in cs.iter().enumerate(){if c.valid{heap.push(Reverse((c.key(),i)));}}
    let mut p=Packer::new(&out.join("packs"),objects.len() as u32)?;let mut plans=writer(&out.join("staging/plans.bin"))?;let mut terms=reader(&out.join("staging/vocabulary.global"))?;let mut current=None;let mut tree=Tree::new();let mut leaf=Leaf::new();let mut hot:BinaryHeap<Reverse<(u32,Reverse<JsKey>,String)>>=BinaryHeap::new();
    fn flush_term(id:u32,tree:Tree,terms:&mut impl Read,plans:&mut impl Write,p:&mut Packer,hot:&mut BinaryHeap<Reverse<(u32,Reverse<JsKey>,String)>>)->Result<()> {let expected=read_u32(terms)?;if expected!=id{return Err("vocabulary/term stream mismatch".into())}let df=read_u32(terms)?;let term=read_string(terms)?;let t=Term{id,df,tree:tree.finish(p)?};if t.tree.count!=df{return Err("posting DF mismatch".into())}let payload=serde_json::to_string(&t)?;write_string(plans,&term)?;write_string(plans,&payload)?;hot.push(Reverse((df,Reverse(JsKey(term)),payload)));if hot.len()>256{hot.pop();}Ok(())}
    let mut previous=None;
    while let Some(Reverse((key,i)))=heap.pop() {
        if previous==Some(key){return Err("duplicate posting document within term".into())}previous=Some(key);
        if current!=Some(key.0){if let Some(id)=current{leaf.flush(&mut tree,&mut p)?;flush_term(id,std::mem::replace(&mut tree,Tree::new()),&mut terms,&mut plans,&mut p,&mut hot)?;}current=Some(key.0);}
        relocate_header(&mut cs[i].header,input_bases[i])?;
        // A size cap supplements the posting-count cap for unusually long documents.
        if !leaf.rows.is_empty() && leaf.positions.len()+cs[i].positions.len()+4>65536 {leaf.flush(&mut tree,&mut p)?;}
        leaf.push(&cs[i])?;if leaf.rows.len()==BLOCK {leaf.flush(&mut tree,&mut p)?;}
        cs[i].advance()?;if cs[i].valid{heap.push(Reverse((cs[i].key(),i)));}
    }
    if let Some(id)=current{leaf.flush(&mut tree,&mut p)?;flush_term(id,tree,&mut terms,&mut plans,&mut p,&mut hot)?;}
    if optional_u32(&mut terms)?.is_some(){return Err("unconsumed vocabulary".into())}plans.flush()?;drop(plans);drop(cs);paths.clear();input_bases.clear();
    let mut documents=Vec::new();let mut buffer=Vec::with_capacity(4096*36);let mut seen=0;
    for (run,&base) in runs.iter().zip(bases) {let mut f=reader(&run_dir(out,run.id).join("documents.final"))?;for _ in 0..run.count{let mut loc=[0;36];f.read_exact(&mut loc)?;for at in [0,12,24]{let n=at_u32(&loc,at).checked_add(base).ok_or("object overflow")?;loc[at..at+4].copy_from_slice(&n.to_le_bytes());}buffer.extend_from_slice(&loc);seen+=1;if buffer.len()==4096*36{documents.push(p.put(&buffer)?);buffer.clear();}}}if !buffer.is_empty(){documents.push(p.put(&buffer)?);}if seen!=count{return Err("document locator count mismatch".into())}
    let mut dictionaries=Vec::new();let mut entries:Vec<(String,Term)>=Vec::with_capacity(256);let mut input=reader(&out.join("staging/plans.bin"))?;
    fn flush_dict(a:&mut Vec<(String,Term)>,ds:&mut Vec<Dictionary>,p:&mut Packer)->Result<()> {if a.is_empty(){return Ok(())}let reference=p.put(&serde_json::to_vec(a)?)?;ds.push(Dictionary{first:a[0].0.clone(),last:a.last().unwrap().0.clone(),reference});a.clear();Ok(())}
    while let Some(n)=optional_u32(&mut input)?{let name=String::from_utf8(read_bytes(&mut input,n as usize)?)?;let payload=read_string(&mut input)?;entries.push((name,serde_json::from_str(&payload)?));if entries.len()==256{flush_dict(&mut entries,&mut dictionaries,&mut p)?;}}flush_dict(&mut entries,&mut dictionaries,&mut p)?;objects.extend(p.finish()?);
    let mut hot_terms=BTreeMap::new();for Reverse((_,Reverse(JsKey(name)),payload)) in hot{hot_terms.insert(name,serde_json::from_str(&payload)?);}
    Ok(Root{format:"CWS1",generation:generation.to_owned(),count,avg_body:averages.0,avg_title:averages.1,corpus_hash:corpus_hash.to_owned(),documents,dictionaries,hot:hot_terms,objects:objects.clone()})
}
