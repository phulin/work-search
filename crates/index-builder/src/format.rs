use crate::util::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{BufWriter, Write},
    path::{Path, PathBuf},
};
pub const PAGE: usize = 262144;
pub const OBJECT: usize = 64 * 1048576;
pub const BLOCK: usize = 128;
pub type Ref = [u32; 3];
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Object {
    pub name: String,
    pub size: u64,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checksums: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Branch {
    pub first: u32,
    pub last: u32,
    pub count: u32,
    pub height: u32,
    pub b: f64,
    pub t: f64,
    pub score: Ref,
    pub positions: Ref,
    pub locators: Ref,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Term {
    pub id: u32,
    pub df: u32,
    pub tree: Branch,
}
#[derive(Clone, Serialize)]
pub struct Dictionary {
    pub first: String,
    pub last: String,
    #[serde(rename = "ref")]
    pub reference: Ref,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Root {
    pub format: &'static str,
    pub generation: String,
    pub count: u32,
    pub avg_body: f64,
    pub avg_title: f64,
    pub corpus_hash: String,
    pub documents: Vec<Ref>,
    pub dictionaries: Vec<Dictionary>,
    pub dictionary_height: u32,
    pub hot: std::collections::BTreeMap<String, Term>,
    pub objects: Vec<Object>,
}
pub fn words(a: &[u32]) -> Vec<u8> {
    let mut b = Vec::with_capacity(a.len() * 4);
    for &n in a {
        b.extend_from_slice(&n.to_le_bytes());
    }
    b
}
pub fn put_ref(out: &mut Vec<u8>, r: Ref) {
    for n in r {
        out.extend_from_slice(&n.to_le_bytes());
    }
}
/// Append a block without allocating a temporary integer word array.
pub fn pack_append(a: &[u32], delta: bool, out: &mut Vec<u8>) {
    let base = if delta {
        a.first().copied().unwrap_or(0)
    } else {
        0
    };
    let mut previous = base;
    let mut max = 0;
    for &n in a {
        let x = if delta {
            n.checked_sub(previous).expect("sorted integers")
        } else {
            n
        };
        max = max.max(x);
        previous = n;
    }
    let width = 32 - max.leading_zeros();
    out.reserve(12 + (a.len() * width as usize).div_ceil(32) * 4);
    out.extend_from_slice(&(a.len() as u32).to_le_bytes());
    out.extend_from_slice(&base.to_le_bytes());
    out.extend_from_slice(&[width as u8, delta as u8, 0, 0]);
    if width == 0 {
        return;
    }
    let mut pending = 0u64;
    let mut bits = 0u32;
    previous = base;
    for &n in a {
        let x = if delta { n - previous } else { n };
        pending |= (x as u64) << bits;
        bits += width;
        if bits >= 32 {
            out.extend_from_slice(&(pending as u32).to_le_bytes());
            pending >>= 32;
            bits -= 32;
        }
        previous = n;
    }
    if bits > 0 {
        out.extend_from_slice(&(pending as u32).to_le_bytes());
    }
}
pub fn pack(a: &[u32], delta: bool) -> Vec<u8> {
    let mut out = Vec::new();
    pack_append(a, delta, &mut out);
    out
}
#[cfg(test)]
pub fn unpack(b: &[u8]) -> Result<Vec<u32>> {
    if b.len() < 12 {
        return Err("truncated packed integers".into());
    }
    let n = at_u32(b, 0) as usize;
    let width = b[8] as usize;
    let delta = b[9];
    if width > 32 || delta > 1 || b.len() != 12 + (n * width).div_ceil(32) * 4 {
        return Err("invalid packed integers".into());
    }
    let mut out = Vec::with_capacity(n);
    let mut prev = at_u32(b, 4);
    let mask = if width == 32 {
        u32::MAX
    } else {
        (1u32 << width) - 1
    };
    for i in 0..n {
        let bit = i * width;
        let shift = bit % 32;
        let mut x = if width > 0 {
            at_u32(b, 12 + bit / 32 * 4) >> shift
        } else {
            0
        };
        if shift + width > 32 {
            x |= at_u32(b, 16 + bit / 32 * 4) << (32 - shift);
        }
        x &= mask;
        if delta == 1 {
            x = prev.checked_add(x).ok_or("position overflow")?
        }
        out.push(x);
        prev = x;
    }
    Ok(out)
}
pub fn encode_branches(a: &[Branch]) -> Vec<u8> {
    let mut out = Vec::with_capacity(a.len() * 72);
    for b in a {
        for n in [b.first, b.last, b.count, b.height] {
            out.extend_from_slice(&n.to_le_bytes());
        }
        out.extend_from_slice(&b.b.to_le_bytes());
        out.extend_from_slice(&b.t.to_le_bytes());
        put_ref(&mut out, b.score);
        put_ref(&mut out, b.positions);
        put_ref(&mut out, b.locators);
        out.extend_from_slice(&[0; 4]);
    }
    out
}
pub struct Packer {
    dir: PathBuf,
    number: u32,
    allocator: std::rc::Rc<std::cell::Cell<u32>>,
    at: usize,
    page_len: usize,
    file: Option<BufWriter<OutputFile>>,
    hash: Sha256,
    crc: crc32fast::Hasher,
    checksums: Vec<u32>,
    pub objects: Vec<Object>,
}
impl Packer {
    pub fn new(dir: &Path, start: u32) -> Result<Self> {
        Self::shared(dir, std::rc::Rc::new(std::cell::Cell::new(start)))
    }
    pub fn shared(dir: &Path, allocator: std::rc::Rc<std::cell::Cell<u32>>) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        Ok(Self {
            dir: dir.into(),
            number: u32::MAX,
            allocator,
            at: 0,
            page_len: 0,
            file: None,
            hash: Sha256::new(),
            crc: crc32fast::Hasher::new(),
            checksums: Vec::new(),
            objects: Vec::new(),
        })
    }
    fn write(&mut self, mut b: &[u8]) -> Result<()> {
        if self.file.is_none() {
            self.file = Some(writer(
                &self.dir.join(format!("plan-{}.bin.writing", self.number)),
            )?)
        }
        self.hash.update(b);
        self.file.as_mut().unwrap().write_all(b)?;
        self.at += b.len();
        while !b.is_empty() {
            let take = (PAGE - self.page_len).min(b.len());
            self.crc.update(&b[..take]);
            self.page_len += take;
            b = &b[take..];
            if self.page_len == PAGE {
                self.checksums
                    .push(std::mem::replace(&mut self.crc, crc32fast::Hasher::new()).finalize());
                self.page_len = 0;
            }
        }
        Ok(())
    }
    pub fn put(&mut self, b: &[u8]) -> Result<Ref> {
        if b.is_empty() || b.len() > OBJECT {
            return Err("invalid blob size".into());
        }
        let mut at = self.at.div_ceil(8) * 8;
        if b.len() <= PAGE && at % PAGE + b.len() > PAGE {
            at = at.div_ceil(PAGE) * PAGE;
        }
        if at + b.len() > OBJECT {
            self.finish_object()?;
            at = 0;
        }
        if self.number == u32::MAX {
            self.number = self.allocator.get();
            self.allocator
                .set(self.number.checked_add(1).ok_or("object count overflow")?);
        }
        if at > self.at {
            static ZEROS: [u8; PAGE] = [0; PAGE];
            self.write(&ZEROS[..at - self.at])?;
        }
        let r = [self.number, at as u32, b.len() as u32];
        self.write(b)?;
        Ok(r)
    }
    fn finish_object(&mut self) -> Result<()> {
        if self.at == 0 {
            return Ok(());
        }
        if self.page_len > 0 {
            self.checksums
                .push(std::mem::replace(&mut self.crc, crc32fast::Hasher::new()).finalize());
            self.page_len = 0;
        }
        if let Some(mut f) = self.file.take() {
            f.flush()?;
        }
        std::fs::rename(
            self.dir.join(format!("plan-{}.bin.writing", self.number)),
            self.dir.join(format!("plan-{}.bin", self.number)),
        )?;
        let sha256 = hex(&std::mem::replace(&mut self.hash, Sha256::new()).finalize());
        let key =
            crate::remote::artifact(&self.dir.join(format!("plan-{}.bin", self.number)), &sha256)?;
        self.objects.push(Object {
            name: format!("plan-{}.bin", self.number),
            size: self.at as u64,
            sha256,
            key,
            checksums: std::mem::take(&mut self.checksums),
        });
        self.at = 0;
        self.number = u32::MAX;
        Ok(())
    }
    pub fn finish(mut self) -> Result<Vec<Object>> {
        self.finish_object()?;
        Ok(self.objects)
    }
}
pub struct Tree {
    levels: Vec<Vec<Branch>>,
}
impl Tree {
    pub fn new() -> Self {
        Self { levels: Vec::new() }
    }
    fn parent(children: &[Branch], p: &mut Packer) -> Result<Branch> {
        Ok(Branch {
            first: children[0].first,
            last: children.last().unwrap().last,
            count: children.iter().map(|b| b.count).sum(),
            height: children[0].height + 1,
            b: children.iter().map(|b| b.b).fold(0.0, f64::max),
            t: children.iter().map(|b| b.t).fold(0.0, f64::max),
            score: p.put(&encode_branches(children))?,
            positions: [0; 3],
            locators: [0; 3],
        })
    }
    pub fn push(&mut self, b: Branch, p: &mut Packer) -> Result<()> {
        let l = b.height as usize;
        if self.levels.len() <= l {
            self.levels.resize_with(l + 1, Vec::new);
        }
        self.levels[l].push(b);
        if self.levels[l].len() == 64 {
            let group = std::mem::take(&mut self.levels[l]);
            let b = Self::parent(&group, p)?;
            self.push(b, p)?;
        }
        Ok(())
    }
    pub fn finish(mut self, p: &mut Packer) -> Result<Branch> {
        loop {
            let l = self
                .levels
                .iter()
                .position(|v| !v.is_empty())
                .ok_or("empty term")?;
            let n: usize = self.levels.iter().map(Vec::len).sum();
            if n == 1 {
                return Ok(self.levels[l].pop().unwrap());
            }
            let group = std::mem::take(&mut self.levels[l]);
            let b = Self::parent(&group, p)?;
            self.push(b, p)?;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packed_round_trip() {
        for d in [false, true] {
            for a in [
                vec![],
                vec![0],
                vec![u32::MAX],
                vec![3; 129],
                vec![0, 127, 128, 65535, u32::MAX],
                (0..129).map(|i| i * 77777).collect(),
            ] {
                assert_eq!(unpack(&pack(&a, d)).unwrap(), a);
            }
        }
        assert!(unpack(&[0; 11]).is_err());
    }
    #[test]
    fn physical_pages_and_checksums() {
        let d = tempfile::tempdir().unwrap();
        let mut p = Packer::new(d.path(), 0).unwrap();
        let a = p.put(&vec![1; PAGE - 10]).unwrap();
        let b = p.put(&[2; 32]).unwrap();
        let c = p.put(&vec![3; PAGE + 7]).unwrap();
        assert_eq!(a[1], 0);
        assert_eq!(b[1] as usize, PAGE);
        assert_eq!(c[1] as usize, PAGE + 32);
        let os = p.finish().unwrap();
        let bytes = std::fs::read(d.path().join(&os[0].name)).unwrap();
        assert_eq!(
            os[0].checksums,
            bytes.chunks(PAGE).map(crc32fast::hash).collect::<Vec<_>>()
        );
    }
}

pub fn decode_branch(b: &[u8; 72]) -> Branch {
    fn r(b: &[u8], p: usize) -> Ref {
        [at_u32(b, p), at_u32(b, p + 4), at_u32(b, p + 8)]
    }
    Branch {
        first: at_u32(b, 0),
        last: at_u32(b, 4),
        count: at_u32(b, 8),
        height: at_u32(b, 12),
        b: at_f64(b, 16),
        t: at_f64(b, 24),
        score: r(b, 32),
        positions: r(b, 44),
        locators: r(b, 56),
    }
}
