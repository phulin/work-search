use crate::{
    format::*,
    ingest::{Run, run_dir},
    util::*,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path, time::Instant};
#[derive(Clone, Serialize, Deserialize)]
pub struct Finalized {
    pub run: u32,
    pub files: Vec<(String, String)>,
    pub objects: Vec<Object>,
    pub milliseconds: u64,
}
#[cfg(test)]
pub fn contribution(tf: u32, df: u32, count: u32, len: u32, avg: f64) -> f64 {
    if tf == 0 {
        return 0.0;
    }
    let idf = (1.0 + (count as f64 - df as f64 + 0.5) / (df as f64 + 0.5)).ln();
    score(tf, len, avg, idf)
}
pub fn score(tf: u32, len: u32, avg: f64, idf: f64) -> f64 {
    if tf == 0 {
        0.0
    } else {
        (idf * (tf as f64 * 2.2))
            / (tf as f64
                + 1.2 * (1.0 - 0.75 + (0.75 * len as f64) / if avg == 0.0 { 1.0 } else { avg }))
    }
}
pub fn finalize(run: &Run, out: &Path, resume: bool) -> Result<Finalized> {
    let dir = run_dir(out, run.id);
    let checkpoint = dir.join("finalized.json");
    if resume && checkpoint.exists() {
        let r: Finalized = read_json(&checkpoint)?;
        verify_files(&dir, &r.files)?;
        return Ok(r);
    }
    let start = Instant::now();
    let mapping = std::fs::read(dir.join("mapping.bin"))?;
    if mapping.len() != run.vocabulary as usize * 8 {
        return Err("invalid local map".into());
    }
    let mut packer = Packer::new(&dir.join("packs"), run.objects.len() as u32)?;
    let mut src = reader(&dir.join("documents.stage"))?;
    let mut loc = digest_writer(&dir.join("documents.final"))?;
    let mut directories = digest_writer(&dir.join("directories.stage"))?;
    let mut offset = 0u32;
    for expected in run.first..run.first + run.count {
        let doc = read_u32(&mut src)?;
        if doc != expected {
            return Err("out of order staged document".into());
        }
        let _bl = read_u32(&mut src)?;
        let _tl = read_u32(&mut src)?;
        let rr = [
            read_u32(&mut src)?,
            read_u32(&mut src)?,
            read_u32(&mut src)?,
        ];
        let head = [
            read_u32(&mut src)?,
            read_u32(&mut src)?,
            read_u32(&mut src)?,
        ];
        let count = read_u32(&mut src)?;
        let mut directory = Vec::with_capacity(count as usize * 32);
        for _ in 0..count {
            let first = read_u32(&mut src)?;
            let n = read_u32(&mut src)?;
            let sr = [
                read_u32(&mut src)?,
                read_u32(&mut src)?,
                read_u32(&mut src)?,
            ];
            let mut tokens = Vec::with_capacity(n as usize);
            for _ in 0..n {
                let local = read_u32(&mut src)?;
                if local >= run.vocabulary {
                    return Err("invalid staged token".into());
                }
                tokens.push(at_u32(&mapping, local as usize * 8));
            }
            let tr = packer.put(&pack(&tokens, false))?;
            directory.extend_from_slice(&words(&[first, n]));
            put_ref(&mut directory, tr);
            put_ref(&mut directory, sr);
        }
        let title_len = read_u32(&mut src)?;
        let _title = read_bytes(&mut src, title_len as usize * 4)?;
        let len: u32 = directory.len().try_into()?;
        directories.write_all(&directory)?;
        for r in [rr, [u32::MAX, offset, len], head] {
            loc.write_all(&words(&r))?;
        }
        offset = offset.checked_add(len).ok_or("staged directory overflow")?;
    }
    if optional_u32(&mut src)?.is_some() {
        return Err("extra staged documents".into());
    }
    let loc_hash = finish_digest(loc)?;
    let directories_hash = finish_digest(directories)?;
    let mut objects = run.objects.clone();
    objects.extend(packer.finish()?);
    let mut files = vec![
        ("documents.final".into(), loc_hash),
        ("directories.stage".into(), directories_hash),
        ("mapping.bin".into(), hex(&Sha256::digest(&mapping))),
    ];
    files.extend(
        objects
            .iter()
            .map(|o| (format!("packs/{}", o.name), o.sha256.clone())),
    );
    let result = Finalized {
        run: run.id,
        objects,
        files,
        milliseconds: start.elapsed().as_millis() as u64,
    };
    atomic_json(&checkpoint, &result)?;
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn basic_scores() {
        assert_eq!(contribution(0, 1, 10, 0, 1.0), 0.0);
        assert!(contribution(1, 1, 100, 1, 10.0) > contribution(1, 99, 100, 1, 10.0));
    }
}
