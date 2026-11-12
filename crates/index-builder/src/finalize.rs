use crate::{util::*,format::*,ingest::{Run,run_dir}};
use serde::{Serialize,Deserialize};
use std::{io::{Read,Write},path::Path,process::{Command,Stdio,Child},time::Instant};
#[derive(Clone,Serialize,Deserialize)]pub struct Finalized {pub run:u32,pub files:Vec<(String,String)>,pub objects:Vec<Object>,pub milliseconds:u64,pub scorer:String}
pub struct Scorer {child:Child,input:Option<std::process::ChildStdin>,output:std::process::ChildStdout}
impl Scorer {
    pub fn new(script:&Path,n:u32,ab:f64,at:f64)->Result<Self>{let mut child=Command::new("node").arg(script).args([n.to_string(),ab.to_string(),at.to_string()]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn()?;let input=child.stdin.take();let output=child.stdout.take().unwrap();Ok(Self{child,input,output})}
    pub fn batch(&mut self,rows:&[[u32;5]])->Result<Vec<[f64;2]>>{let input=self.input.as_mut().unwrap();let mut data=Vec::with_capacity(4+rows.len()*20);data.extend_from_slice(&(rows.len() as u32).to_le_bytes());for r in rows{data.extend_from_slice(&words(r));}input.write_all(&data)?;input.flush()?;let mut out=vec![0;rows.len()*16];self.output.read_exact(&mut out)?;Ok(out.chunks_exact(16).map(|b|[at_f64(b,0),at_f64(b,8)]).collect())}
}
impl Drop for Scorer {fn drop(&mut self){self.input.take();let _=self.child.wait();}}
#[derive(Clone)]struct Doc {rr:Ref,fr:Ref}
struct Pending {term:u32,doc:u32,bf:u32,tf:u32,df:u32,first:Ref,body_len:usize,title_len:usize,at:usize}
pub fn finalize(run:&Run,out:&Path,stats:(u32,f64,f64),scorer_script:&Path,resume:bool)->Result<Finalized> {
    let dir=run_dir(out,run.id);let checkpoint=dir.join("finalized.json");let scorer_hash=checksum(scorer_script)?;
    if resume && checkpoint.exists(){let r:Finalized=read_json(&checkpoint)?;if r.scorer!=scorer_hash{return Err("scorer changed since checkpoint".into())}verify_files(&dir,&r.files)?;return Ok(r)}
    let start=Instant::now();let mapping=std::fs::read(dir.join("mapping.bin"))?;if mapping.len()!=run.vocabulary as usize*8{return Err("invalid local vocabulary map".into())}
    let mut packer=Packer::new(&dir.join("packs"),run.objects.len() as u32)?;let mut ds=reader(&dir.join("documents.stage"))?;let mut doclocs=writer(&dir.join("documents.final"))?;let mut docs=Vec::with_capacity(run.count as usize);
    for expected in run.first..run.first+run.count {
        let doc=read_u32(&mut ds)?;if doc!=expected{return Err("out-of-order document stage".into())}let _bl=read_u32(&mut ds)?;let _tl=read_u32(&mut ds)?;let rr=[read_u32(&mut ds)?,read_u32(&mut ds)?,read_u32(&mut ds)?];let head=[read_u32(&mut ds)?,read_u32(&mut ds)?,read_u32(&mut ds)?];let frames=read_u32(&mut ds)?;let mut directory=Vec::with_capacity(frames as usize*32);
        for _ in 0..frames {let first=read_u32(&mut ds)?;let count=read_u32(&mut ds)?;let sr=[read_u32(&mut ds)?,read_u32(&mut ds)?,read_u32(&mut ds)?];let mut tokens=Vec::with_capacity(count as usize);for _ in 0..count{let local=read_u32(&mut ds)? as usize;if local>=run.vocabulary as usize{return Err("invalid local token ID".into())}tokens.push(at_u32(&mapping,local*8));}let tr=packer.put(&pack(&tokens,false))?;directory.extend_from_slice(&words(&[first,count]));put_ref(&mut directory,tr);put_ref(&mut directory,sr);}
        let title_len=read_u32(&mut ds)?;let _title=read_bytes(&mut ds,title_len as usize*4)?;
        let fr=packer.put(&directory)?;for r in [rr,fr,head]{doclocs.write_all(&words(&r))?;}docs.push(Doc{rr,fr});
    }
    if optional_u32(&mut ds)?.is_some(){return Err("extra staged documents".into())}doclocs.flush()?;
    let mut scorer=Scorer::new(scorer_script,stats.0,stats.1,stats.2)?;let mut src=reader(&dir.join("postings.stage"))?;let mut dest=writer(&dir.join("postings.final"))?;let mut done=false;let mut arena=Vec::new();let mut pending=Vec::new();let mut jobs=Vec::new();
    while !done {
        arena.clear();pending.clear();jobs.clear();
        while pending.len()<16384 && arena.len()<8*1048576 {
            let Some(local)=optional_u32(&mut src)?else{done=true;break};let doc=read_u32(&mut src)?;let bl=read_u32(&mut src)?;let tl=read_u32(&mut src)?;let bf=read_u32(&mut src)?;let tf=read_u32(&mut src)?;let body_len=read_u32(&mut src)? as usize;let title_len=read_u32(&mut src)? as usize;let first=[read_u32(&mut src)?,read_u32(&mut src)?,read_u32(&mut src)?];if local>=run.vocabulary{return Err("invalid posting term".into())}let term=at_u32(&mapping,local as usize*8);let df=at_u32(&mapping,local as usize*8+4);let at=arena.len();let len=body_len.checked_add(title_len).ok_or("position overflow")?;if len>64*1048576{return Err("oversized position row".into())}arena.resize(at+len,0);src.read_exact(&mut arena[at..])?;
            pending.push(Pending{term,doc,bf,tf,df,first,body_len,title_len,at});jobs.push([bf,tf,bl,tl,df]);
        }
        if pending.is_empty(){break}let values=scorer.batch(&jobs)?;
        for (r,s) in pending.iter().zip(values){let d=docs.get((r.doc-run.first) as usize).ok_or("posting document outside run")?;dest.write_all(&words(&[r.term,r.doc,r.bf,r.tf]))?;dest.write_all(&s[0].to_le_bytes())?;dest.write_all(&s[1].to_le_bytes())?;for reference in [d.rr,d.fr,r.first]{dest.write_all(&words(&reference))?;}dest.write_all(&words(&[r.df,r.body_len as u32,r.title_len as u32]))?;dest.write_all(&arena[r.at..r.at+r.body_len+r.title_len])?;}
    }
    dest.flush()?;let mut objects=run.objects.clone();objects.extend(packer.finish()?);let mut names=vec!["postings.final".into(),"documents.final".into(),"mapping.bin".into()];names.extend(objects.iter().map(|o|format!("packs/{}",o.name)));
    let result=Finalized{run:run.id,objects,files:checked_files(&dir,names)?,milliseconds:start.elapsed().as_millis() as u64,scorer:scorer_hash};atomic_json(&checkpoint,&result)?;Ok(result)
}
