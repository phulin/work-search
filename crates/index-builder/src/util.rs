use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufReader, BufWriter, Read, Write},
    path::Path,
};
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub fn hex(a: &[u8]) -> String {
    a.iter().map(|b| format!("{b:02x}")).collect()
}
pub enum InputFile {
    Local(File),
    Stdin(std::io::Stdin),
    Remote(Box<crate::remote::Input>),
}
impl Read for InputFile {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Self::Local(f) => f.read(b),
            Self::Stdin(f) => f.read(b),
            Self::Remote(f) => f.read(b),
        }
    }
}
pub type InputReader = BufReader<InputFile>;
pub fn reader(p: &Path) -> Result<InputReader> {
    // Linux cannot reopen a socket-backed Node stdin through /dev/stdin.
    if p == Path::new("-") {
        return Ok(BufReader::with_capacity(
            256 * 1024,
            InputFile::Stdin(std::io::stdin()),
        ));
    }
    let path = if p == Path::new("-") {
        Path::new("/dev/stdin")
    } else {
        p
    };
    let source = if path.exists() {
        InputFile::Local(File::open(path)?)
    } else if let Some(remote) = crate::remote::Input::open(path)? {
        InputFile::Remote(Box::new(remote))
    } else {
        return Err(format!("missing input {}", path.display()).into());
    };
    Ok(BufReader::with_capacity(256 * 1024, source))
}
pub enum OutputFile {
    Local(File),
    Remote(crate::remote::Output),
}
impl Write for OutputFile {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        match self {
            Self::Local(f) => f.write(b),
            Self::Remote(f) => f.write(b),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Self::Local(f) => f.flush(),
            Self::Remote(f) => f.flush(),
        }
    }
}
fn output(p: &Path) -> Result<OutputFile> {
    Ok(if crate::remote::is_stream(p) {
        OutputFile::Remote(crate::remote::Output::new(p))
    } else {
        OutputFile::Local(File::create(p)?)
    })
}
pub fn writer(p: &Path) -> Result<BufWriter<OutputFile>> {
    Ok(BufWriter::with_capacity(1024 * 1024, output(p)?))
}
pub fn u32le<W: Write>(w: &mut W, n: u32) -> Result<()> {
    w.write_all(&n.to_le_bytes())?;
    Ok(())
}
pub fn read_u32<R: Read>(r: &mut R) -> Result<u32> {
    let mut b = [0; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}
pub fn optional_u32<R: Read>(r: &mut R) -> Result<Option<u32>> {
    let mut b = [0; 4];
    if r.read(&mut b[..1])? == 0 {
        return Ok(None);
    }
    r.read_exact(&mut b[1..])?;
    Ok(Some(u32::from_le_bytes(b)))
}
pub fn at_u32(b: &[u8], p: usize) -> u32 {
    u32::from_le_bytes(b[p..p + 4].try_into().unwrap())
}
pub fn at_f64(b: &[u8], p: usize) -> f64 {
    f64::from_le_bytes(b[p..p + 8].try_into().unwrap())
}
pub fn read_bytes<R: Read>(r: &mut R, n: usize) -> Result<Vec<u8>> {
    if n > 64 * 1048576 {
        return Err("record exceeds 64 MiB limit".into());
    }
    let mut b = vec![0; n];
    r.read_exact(&mut b)?;
    Ok(b)
}
pub fn write_string<W: Write>(w: &mut W, s: &str) -> Result<()> {
    u32le(w, s.len().try_into()?)?;
    w.write_all(s.as_bytes())?;
    Ok(())
}
pub fn read_string<R: Read>(r: &mut R) -> Result<String> {
    let n = read_u32(r)?;
    Ok(String::from_utf8(read_bytes(r, n as usize)?)?)
}
pub fn read_json<T: DeserializeOwned>(p: &Path) -> Result<T> {
    Ok(serde_json::from_reader(reader(p)?)?)
}
pub fn atomic_json<T: Serialize>(p: &Path, v: &T) -> Result<()> {
    let tmp = p.with_extension("json.tmp");
    let mut w = writer(&tmp)?;
    serde_json::to_writer(&mut w, v)?;
    w.write_all(b"\n")?;
    w.flush()?;
    drop(w);
    fs::rename(tmp, p)?;
    Ok(())
}
pub fn checksum(p: &Path) -> Result<String> {
    let mut r = reader(p)?;
    let mut h = Sha256::new();
    let mut b = vec![0; 1048576];
    loop {
        let n = r.read(&mut b)?;
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    Ok(hex(&h.finalize()))
}
pub fn verify_files(dir: &Path, files: &[(String, String)]) -> Result<()> {
    for (name, sha) in files {
        if checksum(&dir.join(name))? != *sha {
            return Err(
                format!("checkpoint checksum mismatch: {}", dir.join(name).display()).into(),
            );
        }
    }
    Ok(())
}
pub fn checked_files(dir: &Path, names: Vec<String>) -> Result<Vec<(String, String)>> {
    names
        .into_iter()
        .map(|n| Ok((n.clone(), checksum(&dir.join(n))?)))
        .collect()
}
pub fn js_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    if a.is_ascii() && b.is_ascii() {
        a.cmp(b)
    } else {
        a.encode_utf16().cmp(b.encode_utf16())
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JsKey(pub String);
impl Ord for JsKey {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        js_cmp(&self.0, &other.0)
    }
}
impl PartialOrd for JsKey {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

// Bound a record before allocation, including a source with no LF at all.
pub fn bounded_line<R: std::io::BufRead>(r: &mut R, out: &mut Vec<u8>, max: usize) -> Result<bool> {
    out.clear();
    loop {
        let b = r.fill_buf()?;
        if b.is_empty() {
            return Ok(!out.is_empty());
        }
        let take = b
            .iter()
            .position(|&n| n == b'\n')
            .map_or(b.len(), |i| i + 1);
        if out.len() + take > max {
            return Err("document input exceeds 64 MiB limit".into());
        }
        let end = b[take - 1] == b'\n';
        out.extend_from_slice(&b[..take]);
        r.consume(take);
        if end {
            out.pop();
            if out.last() == Some(&b'\r') {
                out.pop();
            }
            return Ok(true);
        }
    }
}

/// Leave descriptors for the output, source, logs, and checkpoint files.
pub fn posting_fan_in() -> usize {
    #[cfg(unix)]
    {
        let mut limit = std::mem::MaybeUninit::<libc::rlimit>::uninit();
        // SAFETY: getrlimit initializes this properly aligned struct on success.
        if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, limit.as_mut_ptr()) } == 0 {
            // SAFETY: successful getrlimit initialized both fields.
            return (unsafe { limit.assume_init() }.rlim_cur.saturating_sub(64) as usize)
                .clamp(2, 512);
        }
    }
    48
}

/// Hash accepted file writes below the large BufWriter, not each posting field.
/// This makes checkpoint digests available without rereading temporary files.
pub struct DigestFile {
    file: OutputFile,
    hash: Sha256,
}
impl Write for DigestFile {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        let n = self.file.write(b)?;
        self.hash.update(&b[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}
pub fn digest_writer(p: &Path) -> Result<BufWriter<DigestFile>> {
    Ok(BufWriter::with_capacity(
        1048576,
        DigestFile {
            file: output(p)?,
            hash: Sha256::new(),
        },
    ))
}
pub fn finish_digest(mut w: BufWriter<DigestFile>) -> Result<String> {
    w.flush()?;
    Ok(hex(&w.get_ref().hash.clone().finalize()))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn write_time_digest_matches_file_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("bytes");
        let bytes: Vec<_> = (0..2_500_003u32)
            .map(|n| (n.wrapping_mul(113).wrapping_add(n >> 7)) as u8)
            .collect();
        let mut w = digest_writer(&p).unwrap();
        w.write_all(&bytes[..44]).unwrap();
        w.write_all(&bytes[44..2_000_000]).unwrap();
        for b in bytes[2_000_000..].chunks(73) {
            w.write_all(b).unwrap();
        }
        let hash = finish_digest(w).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), bytes);
        assert_eq!(hash, checksum(&p).unwrap());
    }
}
