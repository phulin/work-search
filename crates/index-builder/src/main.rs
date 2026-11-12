mod finalize;
mod format;
mod ingest;
mod merge;
mod publish;
mod tokenize;
mod util;
use ingest::{Run, Task};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, Write},
    path::PathBuf,
    sync::{Arc, Mutex, mpsc},
    time::Instant,
};
use util::*;
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
struct Config {
    format: String,
    input: Vec<PathBuf>,
    batch_bytes: usize,
    max_documents: u32,
    scorer: String,
    unicode: String,
}
#[derive(Clone)]
struct Args {
    input: Vec<PathBuf>,
    out: PathBuf,
    threads: usize,
    batch_bytes: usize,
    max_documents: u32,
    resume: bool,
}
fn parse() -> Result<Args> {
    let mut a = Args {
        input: Vec::new(),
        out: PathBuf::new(),
        threads: std::thread::available_parallelism()?.get().min(8),
        batch_bytes: 4 * 1048576,
        max_documents: u32::MAX,
        resume: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        match k.as_str() {
            "build" => {}
            "--input" => a
                .input
                .push(PathBuf::from(it.next().ok_or("--input needs a path")?)),
            "--out" => a.out = PathBuf::from(it.next().ok_or("--out needs a path")?),
            "--threads" => a.threads = it.next().ok_or("--threads needs a number")?.parse()?,
            "--batch-mib" => {
                let n: usize = it.next().ok_or("--batch-mib needs a number")?.parse()?;
                a.batch_bytes = n.checked_mul(1048576).ok_or("batch size overflow")?
            }
            "--max-docs" => {
                a.max_documents = it.next().ok_or("--max-docs needs a number")?.parse()?
            }
            "--resume" => a.resume = true,
            _ => return Err(format!("unknown option {k}").into()),
        }
    }
    if a.input.is_empty()
        || a.out.as_os_str().is_empty()
        || a.threads == 0
        || a.threads > 64
        || a.batch_bytes == 0
        || a.batch_bytes > 64 * 1048576
        || a.max_documents == 0
    {
        return Err("usage: work-search-builder build --input FILE [--input FILE...] --out DIR [--threads N] [--batch-mib 4] [--max-docs N] [--resume]".into());
    }
    Ok(a)
}
fn unicode_guard() -> Result<()> {
    let expected = tokenize::V8_UNICODE
        .split('.')
        .take(2)
        .map(str::parse::<u8>)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let n = unicode_normalization::UNICODE_VERSION;
    let l = std::char::UNICODE_VERSION;
    if expected != [n.0, n.1] || expected != [l.0, l.1] {
        return Err(format!("Unicode mismatch: V8={}, normalization={n:?}, Rust lowercase={l:?}; use matching versions",tokenize::V8_UNICODE).into());
    }
    Ok(())
}
fn ingest_all(a: &Args) -> Result<(Vec<Run>, String)> {
    let (send, rx) = mpsc::sync_channel::<Task>(a.threads);
    let rx = Arc::new(Mutex::new(rx));
    let (done, results) = mpsc::channel::<Result<Run>>();
    let mut corpus = Sha256::new();
    let mut count = 0u32;
    let mut run_id = 0u32;
    std::thread::scope(|scope| -> Result<()> {
        for _ in 0..a.threads {
            let rx = rx.clone();
            let done = done.clone();
            scope.spawn(move || {
                loop {
                    let task = rx.lock().unwrap().recv();
                    let Ok(task) = task else { break };
                    let result = ingest::ingest(task, &a.out, a.resume);
                    let failed = result.is_err();
                    if done.send(result).is_err() || failed {
                        break;
                    }
                }
            });
        }
        drop(rx);
        drop(done);
        let mut batch = Vec::new();
        let mut size = 0;
        let mut first = 0;
        let mut hash = Sha256::new();
        'inputs: for path in &a.input {
            let mut r = reader(path)?;
            let mut raw = Vec::new();
            loop {
                if !bounded_line(&mut r, &mut raw, 64 * 1048576)? {
                    break;
                }
                let line = std::str::from_utf8(&raw)?;
                if line.trim().is_empty() {
                    continue;
                }
                if count == a.max_documents {
                    break 'inputs;
                }
                corpus.update(line.as_bytes());
                corpus.update(b"\n");
                hash.update(line.as_bytes());
                hash.update(b"\n");
                size += line.len();
                batch.push(line.to_owned());
                count = count.checked_add(1).ok_or("document count overflow")?;
                if size >= a.batch_bytes {
                    send.send(Task {
                        id: run_id,
                        first,
                        lines: std::mem::take(&mut batch),
                        digest: hex(&std::mem::replace(&mut hash, Sha256::new()).finalize()),
                    })
                    .map_err(|_| "ingestion workers failed")?;
                    run_id += 1;
                    first = count;
                    size = 0;
                }
            }
        }
        if !batch.is_empty() {
            send.send(Task {
                id: run_id,
                first,
                lines: batch,
                digest: hex(&hash.finalize()),
            })
            .map_err(|_| "ingestion workers failed")?;
        }
        drop(send);
        Ok(())
    })?;
    let mut runs = Vec::new();
    for result in results {
        let run = result?;
        eprintln!(
            "run {}: {} docs, {} postings, {} ms",
            run.id, run.count, run.postings, run.milliseconds
        );
        runs.push(run);
    }
    runs.sort_unstable_by_key(|r| r.id);
    if runs.is_empty() {
        return Err("empty corpus".into());
    }
    let seen: u64 = runs.iter().map(|r| r.count as u64).sum();
    if seen != count as u64 {
        return Err("missing ingestion results".into());
    }
    Ok((runs, hex(&corpus.finalize())))
}
fn finalize_all(
    a: &Args,
    runs: &[Run],
    _stats: (u32, f64, f64),
) -> Result<Vec<finalize::Finalized>> {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let (tx, rx) = mpsc::channel();
    std::thread::scope(|scope| {
        for _ in 0..a.threads {
            let tx = tx.clone();
            let next = &next;
            scope.spawn(move || {
                loop {
                    let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if i >= runs.len() {
                        break;
                    }
                    let result = finalize::finalize(&runs[i], &a.out, a.resume);
                    let fail = result.is_err();
                    if tx.send(result).is_err() || fail {
                        break;
                    }
                }
            });
        }
        drop(tx);
    });
    let mut results = Vec::new();
    for r in rx {
        results.push(r?);
    }
    results.sort_unstable_by_key(|r| r.run);
    if results.len() != runs.len() {
        return Err("missing finalized runs".into());
    }
    Ok(results)
}
fn build(a: Args) -> Result<()> {
    unicode_guard()?;
    let start = Instant::now();
    let config = Config {
        format: "rust-cws1-v2".into(),
        input: a
            .input
            .iter()
            .map(std::fs::canonicalize)
            .collect::<std::io::Result<Vec<_>>>()?,
        batch_bytes: a.batch_bytes,
        max_documents: a.max_documents,
        scorer: "rust-f64-ln-v1".into(),
        unicode: tokenize::V8_UNICODE.into(),
    };
    std::fs::create_dir_all(a.out.join("staging"))?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(a.out.join("staging/build.lock"))?;
    lock.try_lock()
        .map_err(|e| format!("another builder owns this output directory: {e}"))?;
    let cp = a.out.join("staging/config.json");
    if cp.exists() {
        if !a.resume {
            return Err("output already contains a build; use --resume or a new directory".into());
        }
        let old: Config = read_json(&cp)?;
        if old != config {
            return Err("resume configuration differs; use a new output directory".into());
        }
    } else {
        atomic_json(&cp, &config)?;
    }
    let stage = Instant::now();
    let (runs, corpus_hash) = ingest_all(&a)?;
    let ingest_ms = stage.elapsed().as_millis();
    let count: u32 = runs.iter().map(|r| r.count).sum();
    let body: u64 = runs.iter().map(|r| r.body_tokens).sum();
    let title: u64 = runs.iter().map(|r| r.title_tokens).sum();
    let ab = body as f64 / count as f64;
    let at = title as f64 / count as f64;
    if a.out.join("root.json").exists() {
        let completed: serde_json::Value = read_json(&a.out.join("staging/completed.json"))?;
        if completed["corpusHash"] != corpus_hash {
            return Err(
                "completed generation has different corpus bytes; use a new output directory"
                    .into(),
            );
        }
        let checks: Vec<(String, String)> = serde_json::from_value(completed["files"].clone())?;
        verify_files(&a.out, &checks)?;
        println!(
            "{}",
            serde_json::to_string(
                &serde_json::json!({"resumedComplete":true,"manifest":read_json::<serde_json::Value>(&a.out.join("manifest.json"))?})
            )?
        );
        return Ok(());
    }
    let stage = Instant::now();
    merge::validate_ids(&a.out, &runs)?;
    let terms = merge::vocabulary(&a.out, &runs)?;
    let vocabulary_ms = stage.elapsed().as_millis();
    eprintln!("vocabulary: {terms} terms, {vocabulary_ms} ms");
    let stage = Instant::now();
    let finals = finalize_all(&a, &runs, (count, ab, at))?;
    let finalize_ms = stage.elapsed().as_millis();
    let stage = Instant::now();
    let (mut objects, bases) = publish::objects(&a.out, &runs, &finals)?;
    let publish_ms = stage.elapsed().as_millis();
    let stage = Instant::now();
    let mut root = publish::emit(
        &a.out,
        &runs,
        &bases,
        &mut objects,
        count,
        (ab, at),
        &corpus_hash,
    )?;
    root.generation = hex(&Sha256::digest(serde_json::to_vec(&root)?));
    let generation = root.generation.clone();
    let emit_ms = stage.elapsed().as_millis();
    let bytes: u64 = root.objects.iter().map(|o| o.size).sum();
    let manifest = serde_json::json!({"builder":"rust-cws1-v2","format":"CWS1","generation":generation,"corpusHash":corpus_hash,"corpusHashContract":"SHA256 of nonempty source JSONL records, original JSON bytes, one LF per record","count":count,"terms":terms,"bodyTokens":body,"titleTokens":title,"bytes":bytes,"buildMs":start.elapsed().as_millis(),"stagesMs":{"ingest":ingest_ms,"vocabularyAndIds":vocabulary_ms,"forwardEncoding":finalize_ms,"relocateAndPublish":publish_ms,"mergeAndEmit":emit_ms},"threads":a.threads,"batchBytes":a.batch_bytes,"runs":runs.len(),"scorer":"Rust float64, approximate FP equality","scoringImplementation":config.scorer,"unicode":config.unicode,"config":config,"objects":root.objects.len()});
    atomic_json(&a.out.join("manifest.json"), &manifest)?;
    // Prepare the root, then publish the completion checkpoint before the root
    // becomes visible. A crash cannot leave a published root without its proof.
    let candidate = a.out.join("staging/root.candidate.json");
    atomic_json(&candidate, &root)?;
    let mut files = checked_files(&a.out, vec!["manifest.json".into()])?;
    files.push(("root.json".into(), checksum(&candidate)?));
    files.extend(
        root.objects
            .iter()
            .map(|o| (format!("packs/{}", o.name), o.sha256.clone())),
    );
    atomic_json(
        &a.out.join("staging/completed.json"),
        &serde_json::json!({"corpusHash":corpus_hash,"files":files}),
    )?;
    std::fs::rename(candidate, a.out.join("root.json"))?;
    println!("{}", serde_json::to_string(&manifest)?);
    Ok(())
}
fn main() {
    let result = (|| -> Result<()> {
        if std::env::args().nth(1).as_deref() == Some("tokens") {
            let stdin = std::io::stdin();
            let mut out = std::io::BufWriter::new(std::io::stdout().lock());
            for line in stdin.lock().lines() {
                let s: String = serde_json::from_str(&line?)?;
                let t = tokenize::Tokens::new(&s);
                let terms: Vec<_> = (0..t.spans.len()).map(|i| t.term(i)).collect();
                serde_json::to_writer(
                    &mut out,
                    &serde_json::json!({"text":t.text,"terms":terms,"starts":t.spans.iter().map(|s|s.start).collect::<Vec<_>>(),"ends":t.spans.iter().map(|s|s.end).collect::<Vec<_>>()}),
                )?;
                out.write_all(b"\n")?;
            }
            out.flush()?;
            return Ok(());
        }
        build(parse()?)
    })();
    if let Err(e) = result {
        eprintln!("builder failed: {e}");
        std::process::exit(1)
    }
}
