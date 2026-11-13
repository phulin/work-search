use crate::js_string::{JsString, Slice};
use crate::{format::*, tokenize::Tokens, util::*};
use libdeflater::{CompressionLvl, Compressor};
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Instant,
};
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Run {
    pub id: u32,
    pub first: u32,
    pub count: u32,
    pub body_tokens: u64,
    pub title_tokens: u64,
    pub input_hash: String,
    pub objects: Vec<Object>,
    pub files: Vec<(String, String)>,
    pub milliseconds: u64,
    pub vocabulary: u32,
    pub postings: u64,
    #[serde(default)]
    pub phases_ms: [u64; 4],
}
pub struct Task {
    pub id: u32,
    pub first: u32,
    pub lines: Vec<String>,
    pub digest: String,
}
#[derive(Deserialize)]
struct Document {
    id: JsString,
    body: JsString,
    #[serde(default, deserialize_with = "title")]
    title: Option<JsString>,
    #[serde(default, deserialize_with = "metadata")]
    metadata: Option<Box<RawValue>>,
}
fn metadata<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<Box<RawValue>>, D::Error> {
    Box::<RawValue>::deserialize(d).map(Some)
}
fn title<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<JsString>, D::Error> {
    JsString::deserialize(d).map(Some)
}
#[derive(Default)]
struct Slot {
    bf: usize,
    tf: usize,
    bs: usize,
    ts: usize,
    bp: usize,
    tp: usize,
}
#[derive(Clone, Default)]
struct Row {
    term: u32,
    doc: u32,
    bl: u32,
    tl: u32,
    bf: u32,
    tf: u32,
    first: Ref,
    at: usize,
    blen: usize,
    tlen: usize,
}
#[derive(Clone, Debug)]
pub struct Vocab {
    pub term: String,
    pub run: u32,
    pub local: u32,
    pub df: u32,
}
impl Vocab {
    pub fn write<W: Write>(&self, w: &mut W) -> Result<()> {
        write_string(w, &self.term)?;
        for n in [self.run, self.local, self.df] {
            u32le(w, n)?;
        }
        Ok(())
    }
    pub fn read<R: Read>(r: &mut R) -> Result<Option<Self>> {
        let Some(n) = optional_u32(r)? else {
            return Ok(None);
        };
        let term = String::from_utf8(read_bytes(r, n as usize)?)?;
        Ok(Some(Self {
            term,
            run: read_u32(r)?,
            local: read_u32(r)?,
            df: read_u32(r)?,
        }))
    }
}
pub fn run_dir(out: &Path, id: u32) -> PathBuf {
    out.join("staging").join(format!("run-{id:06}"))
}
struct TextCompressor {
    codec: Compressor,
    json: Vec<u8>,
    encoded: Vec<u8>,
}
impl TextCompressor {
    fn new() -> Self {
        Self {
            codec: Compressor::new(CompressionLvl::new(1).unwrap()),
            json: Vec::new(),
            encoded: Vec::new(),
        }
    }
    fn put(&mut self, p: &mut Packer, v: &impl Serialize) -> Result<Ref> {
        self.json.clear();
        serde_json::to_writer(&mut self.json, v)?;
        let bound = self.codec.gzip_compress_bound(self.json.len());
        self.encoded.resize(bound, 0);
        let n = self
            .codec
            .gzip_compress(&self.json, &mut self.encoded)
            .map_err(|e| format!("text compression: {e:?}"))?;
        p.put(&self.encoded[..n])
    }
}
fn intern(words: &Tokens, dict: &mut FxHashMap<String, u32>, df: &mut Vec<u32>) -> Vec<u32> {
    (0..words.spans.len())
        .map(|i| {
            let t = words.term(i);
            if let Some(&id) = dict.get(t) {
                id
            } else {
                let id = dict.len() as u32;
                dict.insert(t.to_owned(), id);
                df.push(0);
                id
            }
        })
        .collect()
}
pub fn ingest(task: Task, out: &Path, resume: bool) -> Result<Run> {
    let dir = run_dir(out, task.id);
    let checkpoint = dir.join("ingested.json");
    if resume && checkpoint.exists() {
        let r: Run = read_json(&checkpoint)?;
        if r.input_hash == task.digest
            && r.first == task.first
            && r.count as usize == task.lines.len()
        {
            verify_files(&dir, &r.files)?;
            return Ok(r);
        }
        return Err("input differs from existing checkpoint; use a new output directory".into());
    }
    std::fs::create_dir_all(dir.join("packs"))?;
    let start = Instant::now();
    let mut packer = Packer::new(&dir.join("packs"), 0)?;
    let mut compressor = TextCompressor::new();
    let mut docs = digest_writer(&dir.join("documents.stage"))?;
    let mut dictionary = FxHashMap::default();
    let mut dfs = Vec::new();
    let mut rows = Vec::new();
    let mut slots: Vec<Slot> = Vec::new();
    let mut touched = Vec::new();
    let mut position_scratch = Vec::new();
    let mut arena = Vec::new();
    let mut ids = Vec::new();
    let mut body_tokens = 0;
    let mut title_tokens = 0;
    let mut phases = [0u128; 4];
    for (i, line) in task.lines.iter().enumerate() {
        let stage = Instant::now();
        let d: Document = serde_json::from_str(line)?;
        if d.id.text.is_empty() {
            return Err("empty document ID".into());
        }
        let doc = task
            .first
            .checked_add(i as u32)
            .ok_or("document overflow")?;
        let body_source = d.body.normalized();
        let body = Tokens::new(&body_source.text);
        let title = Tokens::new(d.title.as_ref().map_or("", |s| s.text.as_str()));
        let b = intern(&body, &mut dictionary, &mut dfs);
        let t = intern(&title, &mut dictionary, &mut dfs);
        let bl: u32 = b.len().try_into()?;
        let tl: u32 = t.len().try_into()?;
        body_tokens += bl as u64;
        title_tokens += tl as u64;
        phases[0] += stage.elapsed().as_micros();
        let stage = Instant::now();
        let mut frames = Vec::new();
        let mut snippets = Vec::new();
        for first in (0..b.len().max(1)).step_by(256) {
            let lo = first.saturating_sub(32);
            let hi = (first + 288).min(b.len());
            let char_start = body.spans.get(lo).map_or(0, |s| s.byte_start);
            let char_end = body
                .spans
                .get(hi.wrapping_sub(1))
                .map_or(body.text.len(), |s| s.byte_end);
            let utf16_start = body.spans.get(lo).map_or(0, |s| s.start);
            let starts: Vec<_> = body.spans[lo..hi]
                .iter()
                .map(|s| s.start - utf16_start)
                .collect();
            let ends: Vec<_> = body.spans[lo..hi]
                .iter()
                .map(|s| s.end - utf16_start)
                .collect();
            #[derive(Serialize)]
            struct Passage<'a> {
                first: usize,
                text: Slice<'a>,
                starts: Vec<u32>,
                ends: Vec<u32>,
            }
            let sr = compressor.put(
                &mut packer,
                &Passage {
                    first: lo,
                    text: body_source.slice(&body.text, char_start, char_end, usize::MAX),
                    starts,
                    ends,
                },
            )?;
            snippets.push(sr);
            frames.push((lo as u32, hi - lo, sr));
        }
        #[derive(Serialize)]
        struct Display<'a> {
            id: &'a JsString,
            #[serde(skip_serializing_if = "Option::is_none")]
            title: &'a Option<JsString>,
            #[serde(skip_serializing_if = "Option::is_none")]
            metadata: &'a Option<Box<RawValue>>,
            preview: Slice<'a>,
        }
        // Preview boundary is UTF-16, matching JavaScript's slice(0,400).
        let rr = compressor.put(
            &mut packer,
            &Display {
                id: &d.id,
                title: &d.title,
                metadata: &d.metadata,
                preview: body_source.slice(&body.text, 0, body.text.len(), 400),
            },
        )?;
        for n in [doc, bl, tl] {
            u32le(&mut docs, n)?;
        }
        for r in [rr, snippets[0]] {
            for n in r {
                u32le(&mut docs, n)?;
            }
        }
        u32le(&mut docs, frames.len() as u32)?;
        for (lo, len, sr) in &frames {
            u32le(&mut docs, *lo)?;
            u32le(&mut docs, *len as u32)?;
            for n in *sr {
                u32le(&mut docs, n)?;
            }
            docs.write_all(&words(&b[*lo as usize..*lo as usize + len]))?;
        }
        u32le(&mut docs, tl)?;
        docs.write_all(&words(&t))?;
        phases[1] += stage.elapsed().as_micros();
        let stage = Instant::now();
        slots.resize_with(dictionary.len(), Slot::default);
        touched.clear();
        for &id in &b {
            let slot = &mut slots[id as usize];
            if slot.bf + slot.tf == 0 {
                touched.push(id);
            }
            slot.bf += 1;
        }
        for &id in &t {
            let slot = &mut slots[id as usize];
            if slot.bf + slot.tf == 0 {
                touched.push(id);
            }
            slot.tf += 1;
        }
        let mut offset = 0;
        for &id in &touched {
            let s = &mut slots[id as usize];
            s.bs = offset;
            s.ts = offset + s.bf;
            s.bp = 0;
            s.tp = 0;
            offset += s.bf + s.tf;
        }
        position_scratch.resize(offset, 0);
        for (p, &id) in b.iter().enumerate() {
            let s = &mut slots[id as usize];
            position_scratch[s.bs + s.bp] = p as u32;
            s.bp += 1;
        }
        for (p, &id) in t.iter().enumerate() {
            let s = &mut slots[id as usize];
            position_scratch[s.ts + s.tp] = p as u32;
            s.tp += 1;
        }
        for &term in &touched {
            let slot = &mut slots[term as usize];
            let bp = &position_scratch[slot.bs..slot.bs + slot.bf];
            let tp = &position_scratch[slot.ts..slot.ts + slot.tf];
            let offset = arena.len();
            pack_append(bp, true, &mut arena);
            let blen = arena.len() - offset;
            pack_append(tp, true, &mut arena);
            let tlen = arena.len() - offset - blen;
            rows.push(Row {
                term,
                doc,
                bl,
                tl,
                bf: slot.bf as u32,
                tf: slot.tf as u32,
                first: snippets[bp.first().copied().unwrap_or(0) as usize / 256],
                at: offset,
                blen,
                tlen,
            });
            dfs[term as usize] += 1;
            slot.bf = 0;
            slot.tf = 0;
        }
        ids.push((d.id.id_key(), doc));
        phases[2] += stage.elapsed().as_micros();
    }
    let docs_hash = finish_digest(docs)?;
    let stage = Instant::now();
    let mut vocabulary: Vec<_> = dictionary
        .into_iter()
        .map(|(term, local)| Vocab {
            term,
            run: task.id,
            local,
            df: dfs[local as usize],
        })
        .collect();
    vocabulary.sort_unstable_by(|a, b| js_cmp(&a.term, &b.term));
    let mut next = vec![0usize; vocabulary.len()];
    let mut at = 0;
    for v in &vocabulary {
        next[v.local as usize] = at;
        at += v.df as usize;
    }
    let mut sorted = vec![Row::default(); rows.len()];
    for r in rows {
        let term = r.term;
        sorted[next[term as usize]] = r;
        next[term as usize] += 1;
    }
    let rows = sorted;
    // Stable counting scatter: input rows are already in document order, so this
    // groups terms in linear time without comparison sorting.
    let mut postings = digest_writer(&dir.join("postings.stage"))?;
    for r in &rows {
        let mut header = [0; 44];
        for (i, n) in [
            r.term,
            r.doc,
            r.bl,
            r.tl,
            r.bf,
            r.tf,
            r.blen as u32,
            r.tlen as u32,
            r.first[0],
            r.first[1],
            r.first[2],
        ]
        .into_iter()
        .enumerate()
        {
            header[i * 4..i * 4 + 4].copy_from_slice(&n.to_le_bytes());
        }
        postings.write_all(&header)?;
        postings.write_all(&arena[r.at..r.at + r.blen + r.tlen])?;
    }
    let postings_hash = finish_digest(postings)?;
    let mut vocab = digest_writer(&dir.join("vocabulary.bin"))?;
    for v in &vocabulary {
        v.write(&mut vocab)?;
    }
    let vocab_hash = finish_digest(vocab)?;
    ids.sort_unstable_by(|a, b| js_cmp(&a.0, &b.0));
    let mut idout = digest_writer(&dir.join("ids.bin"))?;
    for (id, doc) in ids {
        write_string(&mut idout, &id)?;
        u32le(&mut idout, doc)?;
    }
    let idout_hash = finish_digest(idout)?;
    let objects = packer.finish()?;
    let mut files = vec![
        ("postings.stage".into(), postings_hash),
        ("documents.stage".into(), docs_hash),
        ("vocabulary.bin".into(), vocab_hash),
        ("ids.bin".into(), idout_hash),
    ];
    // Immutable pack digests were computed while writing; do not reread them.
    files.extend(
        objects
            .iter()
            .map(|o| (format!("packs/{}", o.name), o.sha256.clone())),
    );
    phases[3] = stage.elapsed().as_micros();
    let run = Run {
        id: task.id,
        first: task.first,
        count: task.lines.len() as u32,
        body_tokens,
        title_tokens,
        input_hash: task.digest,
        objects,
        files,
        milliseconds: start.elapsed().as_millis() as u64,
        vocabulary: vocabulary.len() as u32,
        postings: rows.len() as u64,
        phases_ms: phases.map(|t| (t / 1000) as u64),
    };
    atomic_json(&checkpoint, &run)?;
    Ok(run)
}
