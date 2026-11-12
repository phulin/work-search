use crate::{
    ingest::{Run, Vocab, run_dir},
    util::*,
};
use std::{
    cmp::Reverse,
    collections::BinaryHeap,
    io::{Read, Write},
    path::{Path, PathBuf},
};
const FAN_IN: usize = 48;
pub fn merge_vocab(paths: &[PathBuf], out: &Path) -> Result<()> {
    let mut rs = paths
        .iter()
        .map(|p| reader(p))
        .collect::<Result<Vec<_>>>()?;
    let mut heap = BinaryHeap::new();
    let mut heads = vec![None; rs.len()];
    for (i, r) in rs.iter_mut().enumerate() {
        if let Some(v) = Vocab::read(r)? {
            heap.push(Reverse((JsKey(v.term.clone()), v.run, i)));
            heads[i] = Some(v);
        }
    }
    let mut w = writer(out)?;
    while let Some(Reverse((_, _, i))) = heap.pop() {
        heads[i].take().unwrap().write(&mut w)?;
        if let Some(v) = Vocab::read(&mut rs[i])? {
            heap.push(Reverse((JsKey(v.term.clone()), v.run, i)));
            heads[i] = Some(v);
        }
    }
    w.flush()?;
    Ok(())
}
pub fn bounded_vocab(mut paths: Vec<PathBuf>, dir: &Path, label: &str) -> Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let mut level = 0;
    while paths.len() > 1 {
        let mut next = Vec::new();
        for (i, group) in paths.chunks(FAN_IN).enumerate() {
            let dest = dir.join(format!("{label}-{level}-{i}.bin"));
            merge_vocab(group, &dest)?;
            next.push(dest);
        }
        if level > 0 {
            for p in paths {
                std::fs::remove_file(p)?;
            }
        }
        paths = next;
        level += 1;
    }
    paths.pop().ok_or_else(|| "no input runs".into())
}
#[derive(Clone, Copy, Eq, PartialEq, Ord, PartialOrd)]
struct Mapping([u32; 4]);
fn spill_maps(a: &mut Vec<Mapping>, dir: &Path, paths: &mut Vec<PathBuf>) -> Result<()> {
    if a.is_empty() {
        return Ok(());
    }
    a.sort_unstable();
    let p = dir.join(format!("map-sort-{}.bin", paths.len()));
    let mut w = writer(&p)?;
    for e in a.iter() {
        w.write_all(&crate::format::words(&e.0))?;
    }
    w.flush()?;
    paths.push(p);
    a.clear();
    Ok(())
}
fn next_map<R: Read>(r: &mut R) -> Result<Option<Mapping>> {
    let Some(run) = optional_u32(r)? else {
        return Ok(None);
    };
    Ok(Some(Mapping([
        run,
        read_u32(r)?,
        read_u32(r)?,
        read_u32(r)?,
    ])))
}
fn merge_maps(paths: &[PathBuf], out: &Path) -> Result<()> {
    let mut rs = paths
        .iter()
        .map(|p| reader(p))
        .collect::<Result<Vec<_>>>()?;
    let mut h = BinaryHeap::new();
    for (i, r) in rs.iter_mut().enumerate() {
        if let Some(m) = next_map(r)? {
            h.push(Reverse((m, i)));
        }
    }
    let mut w = writer(out)?;
    while let Some(Reverse((m, i))) = h.pop() {
        w.write_all(&crate::format::words(&m.0))?;
        if let Some(m) = next_map(&mut rs[i])? {
            h.push(Reverse((m, i)));
        }
    }
    w.flush()?;
    Ok(())
}
pub fn vocabulary(out: &Path, runs: &[Run]) -> Result<u32> {
    let dir = out.join("staging/merge");
    std::fs::create_dir_all(&dir)?;
    let merged = bounded_vocab(
        runs.iter()
            .map(|r| run_dir(out, r.id).join("vocabulary.bin"))
            .collect(),
        &dir,
        "vocabulary",
    )?;
    let mut input = reader(&merged)?;
    let mut global = writer(&out.join("staging/vocabulary.global"))?;
    let mut maps = Vec::with_capacity(1_048_576);
    let mut map_paths = Vec::new();
    let mut id = 0u32;
    let mut current = Vocab::read(&mut input)?;
    while let Some(first) = current.take() {
        let term = first.term.clone();
        let mut group = vec![first];
        let mut df = group[0].df;
        loop {
            match Vocab::read(&mut input)? {
                Some(v) if v.term == term => {
                    df = df.checked_add(v.df).ok_or("DF overflow")?;
                    group.push(v)
                }
                v => {
                    current = v;
                    break;
                }
            }
        }
        u32le(&mut global, id)?;
        u32le(&mut global, df)?;
        write_string(&mut global, &term)?;
        for v in group {
            maps.push(Mapping([v.run, v.local, id, df]));
            if maps.len() == 1_048_576 {
                spill_maps(&mut maps, &dir, &mut map_paths)?;
            }
        }
        id = id.checked_add(1).ok_or("vocabulary overflow")?;
    }
    global.flush()?;
    spill_maps(&mut maps, &dir, &mut map_paths)?;
    if map_paths.is_empty() {
        for run in runs {
            writer(&run_dir(out, run.id).join("mapping.bin"))?.flush()?;
        }
        return Ok(id);
    }
    let mut level = 0;
    while map_paths.len() > 1 {
        let mut next = Vec::new();
        for (i, g) in map_paths.chunks(FAN_IN).enumerate() {
            let p = dir.join(format!("mapping-{level}-{i}.bin"));
            merge_maps(g, &p)?;
            next.push(p);
        }
        for p in map_paths {
            std::fs::remove_file(p)?;
        }
        map_paths = next;
        level += 1;
    }
    let mut r = reader(map_paths.first().ok_or("no mappings")?)?;
    let mut next = next_map(&mut r)?;
    for run in runs {
        let mut w = writer(&run_dir(out, run.id).join("mapping.bin"))?;
        for local in 0..run.vocabulary {
            let m = next.take().ok_or("missing local mapping")?;
            if m.0[0] != run.id || m.0[1] != local {
                return Err("unordered local mapping".into());
            }
            u32le(&mut w, m.0[2])?;
            u32le(&mut w, m.0[3])?;
            next = next_map(&mut r)?;
        }
        w.flush()?;
    }
    if next.is_some() {
        return Err("extra local mapping".into());
    }
    Ok(id)
}
pub fn validate_ids(out: &Path, runs: &[Run]) -> Result<()> {
    let dir = out.join("staging/ids");
    std::fs::create_dir_all(&dir)?;
    let mut paths = Vec::new();
    for run in runs {
        let mut r = reader(&run_dir(out, run.id).join("ids.bin"))?;
        let path = dir.join(format!("id-{}.bin", run.id));
        let mut w = writer(&path)?;
        while let Some(n) = optional_u32(&mut r)? {
            let term = String::from_utf8(read_bytes(&mut r, n as usize)?)?;
            let doc = read_u32(&mut r)?;
            Vocab {
                term,
                run: run.id,
                local: doc,
                df: 0,
            }
            .write(&mut w)?;
        }
        w.flush()?;
        paths.push(path);
    }
    let path = bounded_vocab(paths, &dir, "ids")?;
    let mut r = reader(&path)?;
    let mut previous = None;
    while let Some(v) = Vocab::read(&mut r)? {
        if previous.as_ref() == Some(&v.term) {
            return Err(format!("duplicate document ID: {}", v.term).into());
        }
        previous = Some(v.term);
    }
    Ok(())
}
// Fixed header + packed position payload; each input cursor reuses its storage.
// term,doc,bf,tf,b:f64,t:f64,locators[9],df,body_bytes,title_bytes.
pub struct RecordCursor {
    pub reader: std::io::BufReader<std::fs::File>,
    pub header: [u8; 80],
    pub positions: Vec<u8>,
    pub valid: bool,
    raw: Option<RawContext>,
}
struct RawContext {
    mapping: Vec<u8>,
    docs: Vec<u8>,
    first: u32,
    base: u32,
    stats: (u32, f64, f64),
    last_local: Option<u32>,
    term: u32,
    df: u32,
    idf: f64,
}
impl RecordCursor {
    pub fn open(p: &Path) -> Result<Self> {
        let mut c = Self {
            reader: reader(p)?,
            header: [0; 80],
            positions: Vec::new(),
            valid: false,
            raw: None,
        };
        c.advance()?;
        Ok(c)
    }
    pub fn raw(out: &Path, run: &Run, base: u32, stats: (u32, f64, f64)) -> Result<Self> {
        let mapping = std::fs::read(run_dir(out, run.id).join("mapping.bin"))?;
        let docs = std::fs::read(run_dir(out, run.id).join("documents.ready"))?;
        let mut c = Self {
            reader: reader(&run_dir(out, run.id).join("postings.stage"))?,
            header: [0; 80],
            positions: Vec::new(),
            valid: false,
            raw: Some(RawContext {
                mapping,
                docs,
                first: run.first,
                base,
                stats,
                last_local: None,
                term: 0,
                df: 0,
                idf: 0.0,
            }),
        };
        c.advance()?;
        Ok(c)
    }
    pub fn advance(&mut self) -> Result<()> {
        if let Some(raw) = &mut self.raw {
            let Some(local) = optional_u32(&mut self.reader)? else {
                self.valid = false;
                return Ok(());
            };
            let mut h = [0; 44];
            h[..4].copy_from_slice(&local.to_le_bytes());
            self.reader.read_exact(&mut h[4..])?;
            let doc = at_u32(&h, 4);
            let bf = at_u32(&h, 16);
            let tf = at_u32(&h, 20);
            if raw.last_local != Some(local) {
                raw.df = at_u32(&raw.mapping, local as usize * 8 + 4);
                raw.term = at_u32(&raw.mapping, local as usize * 8);
                raw.idf =
                    (1.0 + (raw.stats.0 as f64 - raw.df as f64 + 0.5) / (raw.df as f64 + 0.5)).ln();
                raw.last_local = Some(local);
            }
            let df = raw.df;
            let term = raw.term;
            let idf = raw.idf;
            self.header[..4].copy_from_slice(&term.to_le_bytes());
            self.header[4..8].copy_from_slice(&doc.to_le_bytes());
            self.header[8..12].copy_from_slice(&bf.to_le_bytes());
            self.header[12..16].copy_from_slice(&tf.to_le_bytes());
            let b = crate::finalize::score(bf, at_u32(&h, 8), raw.stats.1, idf);
            let t = crate::finalize::score(tf, at_u32(&h, 12), raw.stats.2, idf);
            self.header[16..24].copy_from_slice(&b.to_le_bytes());
            self.header[24..32].copy_from_slice(&t.to_le_bytes());
            let at = (doc - raw.first) as usize * 36;
            self.header[32..56].copy_from_slice(&raw.docs[at..at + 24]);
            self.header[56..68].copy_from_slice(&h[32..44]);
            let o = at_u32(&self.header, 56)
                .checked_add(raw.base)
                .ok_or("object overflow")?;
            self.header[56..60].copy_from_slice(&o.to_le_bytes());
            self.header[68..72].copy_from_slice(&df.to_le_bytes());
            self.header[72..80].copy_from_slice(&h[24..32]);
            let len = at_u32(&h, 24) as usize + at_u32(&h, 28) as usize;
            if len > 64 * 1048576 {
                return Err("oversized position row".into());
            }
            self.positions.resize(len, 0);
            self.reader.read_exact(&mut self.positions)?;
            self.valid = true;
            return Ok(());
        }
        let Some(term) = optional_u32(&mut self.reader)? else {
            self.valid = false;
            return Ok(());
        };
        self.header[..4].copy_from_slice(&term.to_le_bytes());
        self.reader.read_exact(&mut self.header[4..])?;
        let len = at_u32(&self.header, 72) as usize + at_u32(&self.header, 76) as usize;
        if len > 64 * 1048576 {
            return Err("oversized positional row".into());
        }
        self.positions.resize(len, 0);
        self.reader.read_exact(&mut self.positions)?;
        self.valid = true;
        Ok(())
    }
    pub fn key(&self) -> (u32, u32) {
        (at_u32(&self.header, 0), at_u32(&self.header, 4))
    }
    pub fn write<W: Write>(&self, w: &mut W) -> Result<()> {
        w.write_all(&self.header)?;
        w.write_all(&self.positions)?;
        Ok(())
    }
}
pub fn merge_records(paths: &[PathBuf], out: &Path) -> Result<()> {
    let mut cs = paths
        .iter()
        .map(|p| RecordCursor::open(p))
        .collect::<Result<Vec<_>>>()?;
    let mut heap = BinaryHeap::new();
    for (i, c) in cs.iter().enumerate() {
        if c.valid {
            heap.push(Reverse((c.key(), i)));
        }
    }
    let mut w = writer(out)?;
    while let Some(Reverse((_, i))) = heap.pop() {
        cs[i].write(&mut w)?;
        cs[i].advance()?;
        if cs[i].valid {
            heap.push(Reverse((cs[i].key(), i)));
        }
    }
    w.flush()?;
    Ok(())
}
pub fn bounded_records(mut paths: Vec<PathBuf>, out: &Path) -> Result<Vec<PathBuf>> {
    let dir = out.join("staging/merge");
    let mut level = 0;
    while paths.len() > FAN_IN {
        let mut next = Vec::new();
        for (i, g) in paths.chunks(FAN_IN).enumerate() {
            let p = dir.join(format!("postings-{level}-{i}.bin"));
            merge_records(g, &p)?;
            next.push(p);
        }
        if level > 0 {
            for p in paths {
                std::fs::remove_file(p)?;
            }
        }
        paths = next;
        level += 1;
    }
    Ok(paths)
}
