use crate::{
    finalize::Finalized,
    format::*,
    ingest::{Run, run_dir},
    merge::RecordCursor,
    util::*,
};
use std::{
    cmp::Reverse,
    collections::{BTreeMap, BinaryHeap},
    fs,
    io::{Read, Write},
    path::Path,
};
pub fn objects(out: &Path, runs: &[Run], finals: &[Finalized]) -> Result<(Vec<Object>, Vec<u32>)> {
    let mut objects = Vec::new();
    let mut bases = Vec::new();
    fs::create_dir_all(out.join("packs"))?;
    for (run, done) in runs.iter().zip(finals) {
        let base = objects.len() as u32;
        bases.push(base);
        let dir = run_dir(out, run.id);
        for (i, old) in done.objects.iter().enumerate() {
            let name = format!("plan-{}.bin", base + i as u32);
            let source = dir.join("packs").join(&old.name);
            let dest = out.join("packs").join(&name);
            if dest.exists() {
                fs::remove_file(&dest)?;
            }
            if !crate::remote::adopt(&source, &dest)? && fs::hard_link(&source, &dest).is_err() {
                fs::copy(source, dest)?;
            }
            let mut object = old.clone();
            object.name = name;
            objects.push(object);
        }
    }
    // Only directories contain embedded references. Repack this small stream once;
    // adopt immutable text/token objects without copying or rehashing their bytes.
    let mut p = Packer::new(&out.join("packs"), objects.len() as u32)?;
    for (run, &base) in runs.iter().zip(&bases) {
        let dir = run_dir(out, run.id);
        let mut ds = reader(&dir.join("documents.final"))?;
        let mut src = reader(&dir.join("directories.stage"))?;
        let mut ready = writer(&dir.join("documents.ready"))?;
        for _ in 0..run.count {
            let mut loc = [0; 36];
            ds.read_exact(&mut loc)?;
            let len = at_u32(&loc, 20) as usize;
            let mut directory = read_bytes(&mut src, len)?;
            for at in (0..directory.len()).step_by(32) {
                for off in [8, 20] {
                    let o = at_u32(&directory, at + off)
                        .checked_add(base)
                        .ok_or("object overflow")?;
                    directory[at + off..at + off + 4].copy_from_slice(&o.to_le_bytes());
                }
            }
            let fr = p.put(&directory)?;
            loc[12..24].copy_from_slice(&words(&fr));
            for at in [0, 24] {
                let o = at_u32(&loc, at)
                    .checked_add(base)
                    .ok_or("object overflow")?;
                loc[at..at + 4].copy_from_slice(&o.to_le_bytes());
            }
            ready.write_all(&loc)?;
        }
        ready.flush()?;
    }
    objects.extend(p.finish()?);
    Ok((objects, bases))
}
#[derive(Clone)]
struct LeafRow {
    doc: u32,
    bf: u32,
    tf: u32,
    b: f64,
    t: f64,
    loc: [u8; 36],
}
#[derive(Default)]
struct EncodedLeaf {
    term: u32,
    first: u32,
    last: u32,
    count: u32,
    b: f64,
    t: f64,
    scores: Vec<u8>,
    positions: Vec<u8>,
    locators: Vec<u8>,
}
struct Leaf {
    rows: Vec<LeafRow>,
    positions: Vec<u8>,
    offsets: Vec<u32>,
    score_buffer: Vec<u8>,
    position_buffer: Vec<u8>,
    locator_buffer: Vec<u8>,
}
impl Leaf {
    fn new() -> Self {
        Self {
            rows: Vec::with_capacity(BLOCK),
            positions: Vec::new(),
            offsets: vec![0],
            score_buffer: Vec::new(),
            position_buffer: Vec::new(),
            locator_buffer: Vec::new(),
        }
    }
    fn push(&mut self, c: &RecordCursor) -> Result<()> {
        let h = &c.header;
        let body_len = at_u32(h, 72);
        let mut loc = [0; 36];
        loc.copy_from_slice(&h[32..68]);
        self.rows.push(LeafRow {
            doc: at_u32(h, 4),
            bf: at_u32(h, 8),
            tf: at_u32(h, 12),
            b: at_f64(h, 16),
            t: at_f64(h, 24),
            loc,
        });
        self.positions.extend_from_slice(&body_len.to_le_bytes());
        self.positions.extend_from_slice(&c.positions);
        self.offsets.push(self.positions.len().try_into()?);
        Ok(())
    }
    fn flush(
        &mut self,
        term: u32,
        send: &std::sync::mpsc::SyncSender<Result<EncodedLeaf>>,
        free: &std::sync::mpsc::Receiver<EncodedLeaf>,
    ) -> Result<()> {
        if self.rows.is_empty() {
            return Ok(());
        }
        self.position_buffer.clear();
        self.position_buffer
            .extend_from_slice(&(self.rows.len() as u32).to_le_bytes());
        for &o in &self.offsets {
            self.position_buffer.extend_from_slice(&o.to_le_bytes());
        }
        self.position_buffer.extend_from_slice(&self.positions);
        self.locator_buffer.clear();
        for r in &self.rows {
            self.locator_buffer.extend_from_slice(&r.loc);
        }
        let mut docs = [0u32; BLOCK];
        let mut bfs = [0u32; BLOCK];
        let mut tfs = [0u32; BLOCK];
        for (i, r) in self.rows.iter().enumerate() {
            docs[i] = r.doc;
            bfs[i] = r.bf;
            tfs[i] = r.tf;
        }
        self.score_buffer.clear();
        self.score_buffer.resize(20, 0);
        let n = self.rows.len();
        let mut ends = [20usize; 6];
        pack_append(&docs[..n], true, &mut self.score_buffer);
        ends[1] = self.score_buffer.len();
        pack_append(&bfs[..n], false, &mut self.score_buffer);
        ends[2] = self.score_buffer.len();
        pack_append(&tfs[..n], false, &mut self.score_buffer);
        ends[3] = self.score_buffer.len();
        for r in &self.rows {
            self.score_buffer.extend_from_slice(&r.b.to_le_bytes());
        }
        ends[4] = self.score_buffer.len();
        for r in &self.rows {
            self.score_buffer.extend_from_slice(&r.t.to_le_bytes());
        }
        ends[5] = self.score_buffer.len();
        for i in 0..5 {
            self.score_buffer[i * 4..i * 4 + 4]
                .copy_from_slice(&((ends[i + 1] - ends[i]) as u32).to_le_bytes());
        }
        let reuse = free.try_recv().unwrap_or_default();
        let block = EncodedLeaf {
            term,
            first: self.rows[0].doc,
            last: self.rows.last().unwrap().doc,
            count: self.rows.len() as u32,
            b: self.rows.iter().map(|r| r.b).fold(0.0, f64::max),
            t: self.rows.iter().map(|r| r.t).fold(0.0, f64::max),
            scores: std::mem::replace(&mut self.score_buffer, reuse.scores),
            positions: std::mem::replace(&mut self.position_buffer, reuse.positions),
            locators: std::mem::replace(&mut self.locator_buffer, reuse.locators),
        };
        send.send(Ok(block)).map_err(|_| "posting writer stopped")?;
        self.rows.clear();
        self.positions.clear();
        self.offsets.clear();
        self.offsets.push(0);
        Ok(())
    }
}
#[allow(clippy::too_many_arguments)]
pub fn emit(
    out: &Path,
    runs: &[Run],
    bases: &[u32],
    objects: &mut Vec<Object>,
    count: u32,
    averages: (f64, f64),
    corpus_hash: &str,
    reclaim: bool,
) -> Result<Root> {
    let maximum = if crate::remote::enabled() {
        posting_fan_in().min(64)
    } else {
        posting_fan_in()
    };
    // If a spill is necessary, reclaim small completed groups rather than
    // retaining a second copy of nearly every source run at once.
    let fan = if reclaim && runs.len() > maximum {
        maximum.min(64)
    } else {
        maximum
    };
    let dir = out.join("staging/merge");
    let mut cs = if runs.len() <= fan {
        runs.iter()
            .zip(bases)
            .map(|(run, &base)| RecordCursor::raw(out, run, base, (count, averages.0, averages.1)))
            .collect::<Result<Vec<_>>>()?
    } else {
        let mut paths = Vec::new();
        for (i, group) in runs.chunks(fan).enumerate() {
            let mut inputs = group
                .iter()
                .enumerate()
                .map(|(j, r)| {
                    RecordCursor::raw(out, r, bases[i * fan + j], (count, averages.0, averages.1))
                })
                .collect::<Result<Vec<_>>>()?;
            let dest = dir.join(format!("ready-{i}.bin"));
            let mut h = BinaryHeap::new();
            for (j, c) in inputs.iter().enumerate() {
                if c.valid {
                    h.push(Reverse((c.key(), j)));
                }
            }
            let mut w = writer(&dest)?;
            while let Some(Reverse((_, j))) = h.pop() {
                inputs[j].write(&mut w)?;
                inputs[j].advance()?;
                if inputs[j].valid {
                    h.push(Reverse((inputs[j].key(), j)));
                }
            }
            w.flush()?;
            drop(w);
            drop(inputs);
            if reclaim {
                for run in group {
                    crate::remote::remove(&run_dir(out, run.id).join("postings.stage"))?;
                }
            }
            paths.push(dest);
        }
        crate::merge::bounded_records(paths, out)?
            .iter()
            .map(|p| RecordCursor::open(p))
            .collect::<Result<Vec<_>>>()?
    };
    let mut heap = BinaryHeap::new();
    for (i, c) in cs.iter().enumerate() {
        if c.valid {
            heap.push(Reverse((c.key(), i)));
        }
    }
    let allocator = std::rc::Rc::new(std::cell::Cell::new(objects.len() as u32));
    let mut p = Packer::shared(&out.join("packs"), allocator.clone())?;
    let mut scores = Packer::shared(&out.join("packs"), allocator.clone())?;
    let mut positions = Packer::shared(&out.join("packs"), allocator.clone())?;
    let mut locators = Packer::shared(&out.join("packs"), allocator)?;
    let mut plans = writer(&out.join("staging/plans.bin"))?;
    let mut terms = reader(&out.join("staging/vocabulary.global"))?;
    let mut tree = Tree::new();
    let mut hot: BinaryHeap<Reverse<(u32, Reverse<JsKey>, String)>> = BinaryHeap::new();
    fn flush_term(
        id: u32,
        tree: Tree,
        terms: &mut impl Read,
        plans: &mut impl Write,
        p: &mut Packer,
        hot: &mut BinaryHeap<Reverse<(u32, Reverse<JsKey>, String)>>,
    ) -> Result<()> {
        let expected = read_u32(terms)?;
        if expected != id {
            return Err("vocabulary/term stream mismatch".into());
        }
        let df = read_u32(terms)?;
        let term = read_string(terms)?;
        let t = Term {
            id,
            df,
            tree: tree.finish(p)?,
        };
        if t.tree.count != df {
            return Err("posting DF mismatch".into());
        }
        write_string(plans, &term)?;
        u32le(plans, id)?;
        u32le(plans, df)?;
        plans.write_all(&encode_branches(std::slice::from_ref(&t.tree)))?;
        if hot.len() < 256
            || hot.peek().is_some_and(|Reverse((old, Reverse(name), _))| {
                df > *old || (df == *old && js_cmp(&term, &name.0).is_lt())
            })
        {
            let payload = serde_json::to_string(&t)?;
            hot.push(Reverse((df, Reverse(JsKey(term)), payload)));
            if hot.len() > 256 {
                hot.pop();
            }
        }
        Ok(())
    }
    // One producer merges/scores/encodes while the consumer hashes and writes.
    // Bounded queues and buffer recycling overlap I/O without a postings spill
    // or changing deterministic physical order.
    std::thread::scope(|scope| -> Result<()> {
        let (send, receive) = std::sync::mpsc::sync_channel::<Result<EncodedLeaf>>(32);
        let (recycle, free) = std::sync::mpsc::sync_channel::<EncodedLeaf>(32);
        let worker = scope.spawn(move || {
            let produce = (|| -> Result<()> {
                let mut previous = None;
                let mut current = None;
                let mut leaf = Leaf::new();
                while let Some(Reverse((_, i))) = heap.pop() {
                    let competitor = heap.peek().map(|Reverse((key, _))| *key);
                    loop {
                        let key = cs[i].key();
                        if previous == Some(key) {
                            return Err("duplicate posting document within term".into());
                        }
                        previous = Some(key);
                        if current != Some(key.0) {
                            if let Some(id) = current {
                                leaf.flush(id, &send, &free)?;
                            }
                            current = Some(key.0);
                        }
                        if !leaf.rows.is_empty()
                            && leaf.positions.len() + cs[i].positions.len() + 4 > 65536
                        {
                            leaf.flush(key.0, &send, &free)?;
                        }
                        leaf.push(&cs[i])?;
                        if leaf.rows.len() == BLOCK {
                            leaf.flush(key.0, &send, &free)?;
                        }
                        cs[i].advance()?;
                        if !cs[i].valid {
                            break;
                        }
                        if competitor.is_some_and(|other| cs[i].key() > other) {
                            heap.push(Reverse((cs[i].key(), i)));
                            break;
                        }
                    }
                }
                if let Some(id) = current {
                    leaf.flush(id, &send, &free)?;
                }
                Ok(())
            })();
            if let Err(error) = produce {
                let _ = send.send(Err(error));
            }
        });
        let consume = (|| -> Result<()> {
            let mut current = None;
            for next in &receive {
                let block = next?;
                if current != Some(block.term) {
                    if let Some(id) = current {
                        flush_term(
                            id,
                            std::mem::replace(&mut tree, Tree::new()),
                            &mut terms,
                            &mut plans,
                            &mut p,
                            &mut hot,
                        )?;
                    }
                    current = Some(block.term);
                }
                let positions = positions.put(&block.positions)?;
                let locators = locators.put(&block.locators)?;
                let score = scores.put(&block.scores)?;
                tree.push(
                    Branch {
                        first: block.first,
                        last: block.last,
                        count: block.count,
                        height: 0,
                        b: block.b,
                        t: block.t,
                        score,
                        positions,
                        locators,
                    },
                    &mut p,
                )?;
                let _ = recycle.try_send(block);
            }
            if let Some(id) = current {
                flush_term(
                    id,
                    std::mem::replace(&mut tree, Tree::new()),
                    &mut terms,
                    &mut plans,
                    &mut p,
                    &mut hot,
                )?;
            }
            Ok(())
        })();
        // Disconnect before joining so disk errors cannot leave the producer
        // blocked on a full queue.
        drop(receive);
        drop(recycle);
        if worker.join().is_err() {
            return Err("posting encoder panicked".into());
        }
        consume
    })?;
    if optional_u32(&mut terms)?.is_some() {
        return Err("unconsumed vocabulary".into());
    }
    plans.flush()?;
    drop(plans);
    let mut documents = Vec::new();
    let mut buffer = Vec::with_capacity(4096 * 36);
    let mut seen = 0;
    for run in runs {
        let mut f = reader(&run_dir(out, run.id).join("documents.ready"))?;
        for _ in 0..run.count {
            let mut loc = [0; 36];
            f.read_exact(&mut loc)?;
            buffer.extend_from_slice(&loc);
            seen += 1;
            if buffer.len() == 4096 * 36 {
                documents.push(p.put(&buffer)?);
                buffer.clear();
            }
        }
    }
    if !buffer.is_empty() {
        documents.push(p.put(&buffer)?);
    }
    if seen != count {
        return Err("document locator count mismatch".into());
    }
    let mut dictionaries = Vec::new();
    let mut entries: Vec<(String, Term)> = Vec::with_capacity(256);
    let mut input = reader(&out.join("staging/plans.bin"))?;
    fn flush_dict(
        a: &mut Vec<(String, Term)>,
        ds: &mut Vec<Dictionary>,
        p: &mut Packer,
    ) -> Result<()> {
        if a.is_empty() {
            return Ok(());
        }
        let reference = p.put(&serde_json::to_vec(a)?)?;
        ds.push(Dictionary {
            first: a[0].0.clone(),
            last: a.last().unwrap().0.clone(),
            reference,
        });
        a.clear();
        Ok(())
    }
    while let Some(n) = optional_u32(&mut input)? {
        let name = String::from_utf8(read_bytes(&mut input, n as usize)?)?;
        let id = read_u32(&mut input)?;
        let df = read_u32(&mut input)?;
        let mut branch = [0; 72];
        input.read_exact(&mut branch)?;
        entries.push((
            name,
            Term {
                id,
                df,
                tree: decode_branch(&branch),
            },
        ));
        if entries.len() == 256 {
            flush_dict(&mut entries, &mut dictionaries, &mut p)?;
        }
    }
    flush_dict(&mut entries, &mut dictionaries, &mut p)?;
    let mut dictionary_height = 0;
    while dictionaries.len() > 256 {
        let mut upper = Vec::new();
        for group in dictionaries.chunks(256) {
            let reference = p.put(&serde_json::to_vec(group)?)?;
            upper.push(Dictionary {
                first: group[0].first.clone(),
                last: group.last().unwrap().last.clone(),
                reference,
            });
        }
        dictionaries = upper;
        dictionary_height += 1;
    }
    objects.extend(p.finish()?);
    objects.extend(scores.finish()?);
    objects.extend(positions.finish()?);
    objects.extend(locators.finish()?);
    objects.sort_unstable_by_key(|o| {
        o.name
            .strip_prefix("plan-")
            .unwrap()
            .strip_suffix(".bin")
            .unwrap()
            .parse::<u32>()
            .unwrap()
    });
    let mut hot_terms = BTreeMap::new();
    for Reverse((_, Reverse(JsKey(name)), payload)) in hot {
        hot_terms.insert(name, serde_json::from_str(&payload)?);
    }
    Ok(Root {
        format: "CWS1",
        generation: String::new(),
        count,
        avg_body: averages.0,
        avg_title: averages.1,
        corpus_hash: corpus_hash.to_owned(),
        documents,
        dictionaries,
        dictionary_height,
        hot: hot_terms,
        objects: objects.clone(),
    })
}
