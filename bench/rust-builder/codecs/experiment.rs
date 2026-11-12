//! Diagnostic-only codecs and timing. Copied into a generated builder snapshot;
//! never linked into the production builder or its format.
use crate::util::*;
use libdeflater::{CompressionLvl, Compressor, Decompressor};
use serde::Serialize;
use std::{
    cell::RefCell,
    collections::BTreeMap,
    ffi::{CStr, c_char, c_int, c_void},
    fs::File,
    io::{BufReader, BufWriter, Read, Write},
    path::Path,
    sync::OnceLock,
    time::Instant,
};

#[link(name = "zstd")]
unsafe extern "C" {
    fn ZSTD_versionNumber() -> u32;
    fn ZSTD_createCCtx() -> *mut c_void;
    fn ZSTD_freeCCtx(p: *mut c_void) -> usize;
    fn ZSTD_compressBound(n: usize) -> usize;
    fn ZSTD_compressCCtx(
        p: *mut c_void,
        dst: *mut u8,
        cap: usize,
        src: *const u8,
        n: usize,
        level: c_int,
    ) -> usize;
    fn ZSTD_createDCtx() -> *mut c_void;
    fn ZSTD_freeDCtx(p: *mut c_void) -> usize;
    fn ZSTD_decompressDCtx(
        ctx: *mut c_void,
        dst: *mut u8,
        cap: usize,
        src: *const u8,
        n: usize,
    ) -> usize;
    fn ZSTD_isError(n: usize) -> u32;
    fn ZSTD_getErrorName(n: usize) -> *const c_char;
}
#[link(name = "lz4")]
unsafe extern "C" {
    fn LZ4_versionNumber() -> c_int;
    fn LZ4_compressBound(n: c_int) -> c_int;
    fn LZ4_compress_fast(
        src: *const u8,
        dst: *mut u8,
        n: c_int,
        cap: c_int,
        acceleration: c_int,
    ) -> c_int;
    fn LZ4_decompress_safe(src: *const u8, dst: *mut u8, n: c_int, cap: c_int) -> c_int;
}
#[link(name = "brotlienc")]
unsafe extern "C" {
    fn BrotliEncoderMaxCompressedSize(n: usize) -> usize;
    fn BrotliEncoderCompress(
        q: c_int,
        window: c_int,
        mode: c_int,
        n: usize,
        src: *const u8,
        cap: *mut usize,
        dst: *mut u8,
    ) -> c_int;
}
#[link(name = "brotlidec")]
unsafe extern "C" {
    fn BrotliDecoderDecompress(n: usize, src: *const u8, cap: *mut usize, dst: *mut u8) -> c_int;
}
pub fn name() -> String {
    std::env::var("BUILDER_TEXT_CODEC").unwrap_or("gzip".into())
}
pub fn format_name() -> &'static str {
    if name() == "gzip" {
        "CWS1"
    } else {
        "CWS1-CODEC-EXPERIMENT"
    }
}
pub fn versions() -> serde_json::Value {
    unsafe { serde_json::json!({"zstd":ZSTD_versionNumber(),"lz4":LZ4_versionNumber()}) }
}
fn enabled() -> bool {
    static E: OnceLock<bool> = OnceLock::new();
    *E.get_or_init(|| std::env::var_os("CODEC_PROFILE").is_some())
}
pub fn begin() -> Option<Instant> {
    enabled().then(Instant::now)
}
#[derive(Default, Serialize)]
struct Stats {
    nanoseconds: BTreeMap<&'static str, u128>,
    records: BTreeMap<&'static str, u64>,
    raw_bytes: BTreeMap<&'static str, u64>,
    encoded_bytes: BTreeMap<&'static str, u64>,
}
thread_local! { static STATS: RefCell<Stats> = RefCell::new(Stats::default()); }
pub fn end(label: &'static str, t: Option<Instant>) {
    if !enabled() {
        return;
    }
    if let Some(t) = t {
        let elapsed = t.elapsed().as_nanos();
        STATS.with(|s| *s.borrow_mut().nanoseconds.entry(label).or_default() += elapsed);
    }
}
pub fn record(kind: &'static str, raw: usize, encoded: usize) {
    if enabled() {
        STATS.with(|s| {
            let mut s = s.borrow_mut();
            *s.records.entry(kind).or_default() += 1;
            *s.raw_bytes.entry(kind).or_default() += raw as u64;
            *s.encoded_bytes.entry(kind).or_default() += encoded as u64;
        });
    }
}
pub fn finish(dir: &Path) -> Result<()> {
    if enabled() {
        let stats = STATS.with(|s| std::mem::take(&mut *s.borrow_mut()));
        atomic_json(&dir.join("codec-profile.json"), &stats)?;
    }
    Ok(())
}

pub struct Codec {
    name: String,
    gzip: Compressor,
    gunzip: Decompressor,
    zstd: *mut c_void,
    dzstd: *mut c_void,
}
impl Codec {
    pub fn new(name: String) -> Self {
        assert!(
            [
                "gzip",
                "deflate",
                "zstd-1",
                "zstd-fast1",
                "zstd-fast3",
                "lz4",
                "brotli-0",
                "none"
            ]
            .contains(&name.as_str()),
            "unknown codec"
        );
        let zstd = unsafe { ZSTD_createCCtx() };
        assert!(!zstd.is_null());
        Self {
            name,
            gzip: Compressor::new(CompressionLvl::new(1).unwrap()),
            gunzip: Decompressor::new(),
            zstd,
            dzstd: unsafe { ZSTD_createDCtx() },
        }
    }
    pub fn encode(&mut self, raw: &[u8], out: &mut Vec<u8>) -> Result<usize> {
        let n = match self.name.as_str() {
            "gzip" | "deflate" => {
                out.resize(self.gzip.gzip_compress_bound(raw.len()), 0);
                if self.name == "gzip" {
                    self.gzip.gzip_compress(raw, out)?
                } else {
                    self.gzip.deflate_compress(raw, out)?
                }
            }
            "zstd-1" | "zstd-fast1" | "zstd-fast3" => unsafe {
                let level = match self.name.as_str() {
                    "zstd-1" => 1,
                    "zstd-fast1" => -1,
                    _ => -3,
                };
                out.resize(ZSTD_compressBound(raw.len()), 0);
                let n = ZSTD_compressCCtx(
                    self.zstd,
                    out.as_mut_ptr(),
                    out.len(),
                    raw.as_ptr(),
                    raw.len(),
                    level,
                );
                if ZSTD_isError(n) != 0 {
                    return Err(CStr::from_ptr(ZSTD_getErrorName(n))
                        .to_string_lossy()
                        .into_owned()
                        .into());
                }
                n
            },
            "lz4" => unsafe {
                let size = c_int::try_from(raw.len())?;
                let bound = LZ4_compressBound(size);
                if bound <= 0 {
                    return Err("LZ4 bound".into());
                }
                out.resize(bound as usize + 4, 0);
                out[..4].copy_from_slice(&(raw.len() as u32).to_le_bytes());
                let n = LZ4_compress_fast(raw.as_ptr(), out.as_mut_ptr().add(4), size, bound, 1);
                if n <= 0 {
                    return Err("LZ4 compression".into());
                }
                n as usize + 4
            },
            "brotli-0" => unsafe {
                out.resize(BrotliEncoderMaxCompressedSize(raw.len()), 0);
                let mut n = out.len();
                if BrotliEncoderCompress(
                    0,
                    22,
                    1,
                    raw.len(),
                    raw.as_ptr(),
                    &mut n,
                    out.as_mut_ptr(),
                ) == 0
                {
                    return Err("Brotli compression".into());
                }
                n
            },
            "none" => {
                out.clear();
                out.extend_from_slice(raw);
                raw.len()
            }
            _ => unreachable!(),
        };
        Ok(n)
    }
    fn decode(&mut self, encoded: &[u8], raw_size: usize, out: &mut Vec<u8>) -> Result<usize> {
        out.resize(raw_size, 0);
        Ok(match self.name.as_str() {
            "gzip" => self.gunzip.gzip_decompress(encoded, out)?,
            "deflate" => self.gunzip.deflate_decompress(encoded, out)?,
            "zstd-1" | "zstd-fast1" | "zstd-fast3" => unsafe {
                let n = ZSTD_decompressDCtx(
                    self.dzstd,
                    out.as_mut_ptr(),
                    out.len(),
                    encoded.as_ptr(),
                    encoded.len(),
                );
                if ZSTD_isError(n) != 0 {
                    return Err("Zstd decode".into());
                }
                n
            },
            "lz4" => unsafe {
                if encoded.len() < 4 || at_u32(encoded, 0) as usize != raw_size {
                    return Err("LZ4 size".into());
                }
                let n = LZ4_decompress_safe(
                    encoded[4..].as_ptr(),
                    out.as_mut_ptr(),
                    c_int::try_from(encoded.len() - 4)?,
                    c_int::try_from(out.len())?,
                );
                if n < 0 {
                    return Err("LZ4 decode".into());
                }
                n as usize
            },
            "brotli-0" => unsafe {
                let mut n = out.len();
                if BrotliDecoderDecompress(
                    encoded.len(),
                    encoded.as_ptr(),
                    &mut n,
                    out.as_mut_ptr(),
                ) != 1
                {
                    return Err("Brotli decode".into());
                }
                n
            },
            "none" => {
                out.copy_from_slice(encoded);
                encoded.len()
            }
            _ => unreachable!(),
        })
    }
}
impl Drop for Codec {
    fn drop(&mut self) {
        unsafe {
            ZSTD_freeCCtx(self.zstd);
            ZSTD_freeDCtx(self.dzstd);
        }
    }
}

pub struct TextCompressor {
    codec: Codec,
    json: Vec<u8>,
    encoded: Vec<u8>,
    records: usize,
    sample_offset: usize,
    fixture: Option<BufWriter<File>>,
}
impl TextCompressor {
    pub fn new(run: u32, dir: &Path) -> Self {
        Self {
            codec: Codec::new(name()),
            json: Vec::new(),
            encoded: Vec::new(),
            records: 0,
            sample_offset: run as usize % 64,
            fixture: std::env::var_os("CODEC_FIXTURES")
                .map(|_| BufWriter::new(File::create(dir.join("codec-fixtures.bin")).unwrap())),
        }
    }
    pub fn put(
        &mut self,
        p: &mut crate::format::Packer,
        value: &impl Serialize,
    ) -> Result<crate::format::Ref> {
        self.json.clear();
        let t = begin();
        serde_json::to_writer(&mut self.json, value)?;
        end("json_serialization", t);
        let kind = if self.json.starts_with(b"{\"first\":") {
            "passage"
        } else {
            "display"
        };
        if let Some(f) = &mut self.fixture {
            if self.records % 64 == self.sample_offset {
                f.write_all(&[u8::from(kind == "display")])?;
                u32le(f, self.json.len().try_into()?)?;
                f.write_all(&self.json)?;
            }
        }
        self.records += 1;
        let t = begin();
        let n = self.codec.encode(&self.json, &mut self.encoded)?;
        end("compression", t);
        record(kind, self.json.len(), n);
        let t = begin();
        let r = p.put(&self.encoded[..n])?;
        end("text_pack_hash_crc_write", t);
        Ok(r)
    }
    pub fn flush(&mut self) -> Result<()> {
        if let Some(f) = &mut self.fixture {
            f.flush()?;
        }
        Ok(())
    }
}

pub fn micro(args: &[String]) -> Result<()> {
    let (dir, out) = (&args[0], &args[1]);
    std::fs::create_dir_all(out)?;
    let mut paths: Vec<_> = std::fs::read_dir(Path::new(dir).join("staging"))?
        .filter_map(|p| p.ok())
        .map(|p| p.path().join("codec-fixtures.bin"))
        .filter(|p| p.exists())
        .collect();
    paths.sort();
    let mut inputs = Vec::new();
    for p in paths {
        let mut r = BufReader::new(File::open(p)?);
        loop {
            let mut kind = [0];
            if r.read(&mut kind)? == 0 {
                break;
            }
            let n = read_u32(&mut r)?;
            let b = read_bytes(&mut r, n as usize)?;
            inputs.push((kind[0], b));
        }
    }
    if inputs.is_empty() {
        return Err("no fixtures".into());
    }
    let names = [
        "gzip",
        "deflate",
        "zstd-1",
        "zstd-fast1",
        "zstd-fast3",
        "lz4",
        "brotli-0",
        "none",
    ];
    for round in 0..3 {
        let order: Vec<_> = if round % 2 == 0 {
            names.to_vec()
        } else {
            names.iter().rev().copied().collect()
        };
        for name in order {
            for kind in [0, 1] {
                let data: Vec<_> = inputs
                    .iter()
                    .filter(|(k, _)| *k == kind)
                    .map(|(_, b)| b)
                    .collect();
                let mut codec = Codec::new(name.into());
                let mut encoded = Vec::new();
                let mut batches = Vec::new();
                let t = Instant::now();
                let mut bytes = 0;
                for raw in &data {
                    let n = codec.encode(raw, &mut encoded)?;
                    bytes += n;
                    batches.push(encoded[..n].to_vec());
                }
                let encode_ns = t.elapsed().as_nanos();
                let mut decoded = Vec::new();
                let t = Instant::now();
                for (raw, b) in data.iter().zip(&batches) {
                    let n = codec.decode(b, raw.len(), &mut decoded)?;
                    if n != raw.len() || decoded != **raw {
                        return Err("codec roundtrip mismatch".into());
                    }
                }
                let decode_ns = t.elapsed().as_nanos();
                if round == 0 {
                    let mut f = BufWriter::new(File::create(
                        Path::new(out).join(format!("{name}-{kind}.bin")),
                    )?);
                    for (raw, b) in data.iter().zip(&batches) {
                        u32le(&mut f, raw.len().try_into()?)?;
                        u32le(&mut f, b.len().try_into()?)?;
                        f.write_all(b)?;
                    }
                    f.flush()?;
                }
                println!(
                    "{}",
                    serde_json::json!({"codec":name,"round":round,"kind":if kind==0{"passage"}else{"display"},"records":data.len(),"rawBytes":data.iter().map(|b|b.len()).sum::<usize>(),"encodedBytes":bytes,"nativeEncodeAndCopyNs":encode_ns,"nativeDecodeAndVerifyNs":decode_ns,"versions":versions()})
                );
            }
        }
    }
    Ok(())
}
