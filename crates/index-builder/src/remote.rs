//! Bounded offline R2 spill store. Serving artifacts are content addressed;
//! temporary streams have a build-scoped key and a checksum-verified reader.
use crate::util::*;
use libdeflater::{CompressionLvl, Compressor};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdout, Command, Stdio},
    sync::{Condvar, Mutex, OnceLock},
};
const CHUNK: usize = 64 * 1048576;
struct Store {
    url: String,
    config: PathBuf,
    scope: String,
    ledger: Mutex<File>,
}
static STORE: OnceLock<Store> = OnceLock::new();
static UPLOADS: Mutex<u8> = Mutex::new(0);
static AVAILABLE: Condvar = Condvar::new();
struct UploadPermit;
impl UploadPermit {
    fn acquire() -> Self {
        let mut n = UPLOADS.lock().unwrap();
        while *n >= 2 {
            n = AVAILABLE.wait(n).unwrap();
        }
        *n += 1;
        Self
    }
}
impl Drop for UploadPermit {
    fn drop(&mut self) {
        *UPLOADS.lock().unwrap() -= 1;
        AVAILABLE.notify_one();
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct Chunk {
    key: String,
    sha256: String,
    size: usize,
}
#[derive(Serialize, Deserialize)]
struct Receipt {
    chunks: Vec<Chunk>,
    size: u64,
    sha256: String,
}
pub fn enabled() -> bool {
    STORE.get().is_some()
}
pub fn configure(out: &Path, url: &str, token_file: &Path) -> Result<()> {
    if !url.starts_with("https://") || !url.ends_with(".workers.dev") {
        return Err("offline store must be a Cloudflare Worker HTTPS origin".into());
    }
    fs::create_dir_all(out.join("staging"))?;
    let token = fs::read_to_string(token_file)?;
    let token = token.trim();
    if token.is_empty() || token.bytes().any(|b| b < 32 || b == b'"' || b == b'\\') {
        return Err("invalid offline store token".into());
    }
    let config = out.join("staging/.curl-auth");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&config)?;
    writeln!(file, "header = \"Authorization: Bearer {token}\"")?;
    let scope_path = out.join("remote-scope.json");
    let scope = if scope_path.exists() {
        read_json::<String>(&scope_path)?
    } else {
        let scope = hex(&Sha256::digest(format!(
            "{}:{:?}:{}",
            out.display(),
            std::time::SystemTime::now(),
            std::process::id()
        )));
        atomic_json(&scope_path, &scope)?;
        scope
    };
    let ledger = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(out.join("remote-objects.jsonl"))?;
    STORE
        .set(Store {
            url: url.trim_end_matches('/').into(),
            config,
            scope,
            ledger: Mutex::new(ledger),
        })
        .map_err(|_| "offline store already configured")?;
    Ok(())
}
pub fn cleanup() {
    if let Some(s) = STORE.get() {
        let _ = fs::remove_file(&s.config);
    }
}
fn command() -> Command {
    let s = STORE.get().unwrap();
    let mut c = Command::new("curl");
    c.args([
        "--silent",
        "--show-error",
        "--fail",
        "--retry",
        "5",
        "--retry-all-errors",
        "--retry-delay",
        "1",
        "--max-time",
        "180",
        "--config",
    ])
    .arg(&s.config);
    c
}
fn base64(data: &[u8]) -> String {
    const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for b in data.chunks(3) {
        let n = (u32::from(b[0]) << 16)
            | (u32::from(*b.get(1).unwrap_or(&0)) << 8)
            | u32::from(*b.get(2).unwrap_or(&0));
        out.push(ABC[(n >> 18) as usize] as char);
        out.push(ABC[((n >> 12) & 63) as usize] as char);
        out.push(if b.len() > 1 {
            ABC[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if b.len() > 2 {
            ABC[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
fn upload(data: &[u8], artifact: bool) -> Result<Chunk> {
    let _permit = UploadPermit::acquire();
    let s = STORE.get().ok_or("offline store not configured")?;
    let sha256 = hex(&Sha256::digest(data));
    let key = if artifact {
        format!("{sha256}/plan-0.bin")
    } else {
        format!("{sha256}/stage-{}.bin", s.scope)
    };
    let mut crc = Vec::new();
    for page in data.chunks(262144) {
        crc.extend_from_slice(&crc32fast::hash(page).to_le_bytes());
    }
    let mut compressor = Compressor::new(CompressionLvl::new(1).unwrap());
    let mut gzip = vec![0; compressor.gzip_compress_bound(data.len())];
    let n = compressor
        .gzip_compress(data, &mut gzip)
        .map_err(|e| format!("offline gzip: {e:?}"))?;
    let mut c = command();
    c.args([
        "--request",
        "PUT",
        "--header",
        &format!("x-sha256: {sha256}"),
        "--header",
        &format!("x-raw-length: {}", data.len()),
        "--header",
        &format!("x-page-crc32: {}", base64(&crc)),
        "--header",
        &format!("content-length: {n}"),
        "--upload-file",
        "-",
    ])
    .arg(format!("{}/{}", s.url, key))
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    for retry in 0..5 {
        let mut child = c.spawn()?;
        let transfer = child.stdin.take().unwrap().write_all(&gzip[..n]);
        let result = child.wait_with_output()?;
        if result.status.success() {
            break;
        }
        if retry == 4 {
            return Err(format!(
                "offline R2 upload failed: {} ({:?})",
                String::from_utf8_lossy(&result.stderr),
                transfer.err()
            )
            .into());
        }
        std::thread::sleep(std::time::Duration::from_secs(1 << retry));
    }
    let chunk = Chunk {
        key,
        sha256,
        size: data.len(),
    };
    let mut ledger = s.ledger.lock().unwrap();
    serde_json::to_writer(
        &mut *ledger,
        &serde_json::json!({"key":chunk.key,"sha256":chunk.sha256,"size":chunk.size,"artifact":artifact}),
    )?;
    writeln!(ledger)?;
    ledger.flush()?;
    Ok(chunk)
}
fn sidecar(path: &Path) -> PathBuf {
    let mut p = path.as_os_str().to_os_string();
    p.push(".remote.json");
    p.into()
}
pub fn adopt(source: &Path, dest: &Path) -> Result<bool> {
    if !source.exists() && sidecar(source).exists() {
        fs::copy(sidecar(source), sidecar(dest))?;
        return Ok(true);
    }
    Ok(false)
}
pub fn remove(path: &Path) -> Result<()> {
    for p in [path.to_path_buf(), sidecar(path)] {
        match fs::remove_file(p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
pub fn artifact(path: &Path, expected: &str) -> Result<Option<String>> {
    if !enabled() {
        return Ok(None);
    }
    let data = fs::read(path)?;
    if hex(&Sha256::digest(&data)) != expected {
        return Err("artifact checksum changed before publication".into());
    }
    let chunk = upload(&data, true)?;
    let key = chunk.key.clone();
    atomic_json(
        &sidecar(path),
        &Receipt {
            size: data.len() as u64,
            sha256: expected.into(),
            chunks: vec![chunk],
        },
    )?;
    fs::remove_file(path)?;
    Ok(Some(key))
}
pub fn is_stream(path: &Path) -> bool {
    if !enabled() {
        return false;
    }
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    name == "documents.stage"
        || name == "postings.stage"
        || name.starts_with("ready-")
        || (name.starts_with("postings-") && name.ends_with(".bin"))
}
pub struct Output {
    path: PathBuf,
    buffer: Vec<u8>,
    chunks: Vec<Chunk>,
    size: u64,
    hash: Sha256,
}
impl Output {
    pub fn new(path: &Path) -> Self {
        Self {
            path: path.into(),
            buffer: Vec::with_capacity(CHUNK),
            chunks: Vec::new(),
            size: 0,
            hash: Sha256::new(),
        }
    }
    fn spill(&mut self) -> std::io::Result<()> {
        if !self.buffer.is_empty() {
            let chunk = upload(&self.buffer, false).map_err(io_error)?;
            self.chunks.push(chunk);
            self.buffer.clear();
        }
        Ok(())
    }
}
fn io_error(e: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(e.to_string())
}
impl Write for Output {
    fn write(&mut self, mut data: &[u8]) -> std::io::Result<usize> {
        let n = data.len();
        self.hash.update(data);
        self.size += n as u64;
        while !data.is_empty() {
            let take = (CHUNK - self.buffer.len()).min(data.len());
            self.buffer.extend_from_slice(&data[..take]);
            data = &data[take..];
            if self.buffer.len() == CHUNK {
                self.spill()?;
            }
        }
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.spill()?;
        atomic_json(
            &sidecar(&self.path),
            &Receipt {
                chunks: self.chunks.clone(),
                size: self.size,
                sha256: hex(&self.hash.clone().finalize()),
            },
        )
        .map_err(io_error)
    }
}
struct Active {
    child: Child,
    stdout: ChildStdout,
    hash: Sha256,
    size: usize,
    chunk: Chunk,
}
pub struct Input {
    receipt: Receipt,
    next: usize,
    active: Option<Active>,
    hash: Sha256,
    size: u64,
    verified: bool,
}
impl Input {
    pub fn open(path: &Path) -> Result<Option<Self>> {
        if !sidecar(path).exists() {
            return Ok(None);
        }
        Ok(Some(Self {
            receipt: read_json(&sidecar(path))?,
            next: 0,
            active: None,
            hash: Sha256::new(),
            size: 0,
            verified: false,
        }))
    }
}
impl Read for Input {
    fn read(&mut self, data: &mut [u8]) -> std::io::Result<usize> {
        if data.is_empty() {
            return Ok(0);
        }
        loop {
            if self.active.is_none() {
                if self.next == self.receipt.chunks.len() {
                    if !self.verified {
                        if self.size != self.receipt.size
                            || hex(&self.hash.clone().finalize()) != self.receipt.sha256
                        {
                            return Err(io_error("offline stream checksum mismatch"));
                        }
                        self.verified = true;
                    }
                    return Ok(0);
                }
                let chunk = self.receipt.chunks[self.next].clone();
                self.next += 1;
                let s = STORE
                    .get()
                    .ok_or_else(|| io_error("offline store required for remote checkpoint"))?;
                let mut c = command();
                let mut child = c
                    .arg(format!("{}/{}", s.url, chunk.key))
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()?;
                let stdout = child.stdout.take().unwrap();
                self.active = Some(Active {
                    child,
                    stdout,
                    hash: Sha256::new(),
                    size: 0,
                    chunk,
                });
            }
            let a = self.active.as_mut().unwrap();
            let n = a.stdout.read(data)?;
            if n > 0 {
                a.hash.update(&data[..n]);
                a.size += n;
                self.hash.update(&data[..n]);
                self.size += n as u64;
                return Ok(n);
            }
            let mut a = self.active.take().unwrap();
            if !a.child.wait()?.success()
                || a.size != a.chunk.size
                || hex(&a.hash.finalize()) != a.chunk.sha256
            {
                return Err(io_error("offline chunk transfer/checksum failed"));
            }
        }
    }
}
impl Drop for Input {
    fn drop(&mut self) {
        if let Some(a) = &mut self.active {
            let _ = a.child.kill();
            let _ = a.child.wait();
        }
    }
}
