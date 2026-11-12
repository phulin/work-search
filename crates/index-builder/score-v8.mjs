// Binary, batched canonical scorer. No JSON or per-posting process invocations.
import fs from 'node:fs';
const [count, avgBody, avgTitle] = process.argv.slice(2).map(Number);
if (!count || !Number.isFinite(avgBody) || !Number.isFinite(avgTitle)) throw Error('Invalid corpus statistics');
const header = Buffer.allocUnsafe(4);
function readExact(b) { let at = 0; while (at < b.length) { const n = fs.readSync(0, b, at, b.length - at, null); if (!n) { if (at) throw Error('Truncated scorer input'); return false; } at += n; } return true; }
const idfs = new Map();
for (;;) {
  if (!readExact(header)) break;
  const n = header.readUInt32LE(0); if (n > 65536) throw Error('Oversized score batch');
  const data = Buffer.allocUnsafe(n * 20); if (!readExact(data)) throw Error('Missing score data');
  const out = Buffer.allocUnsafe(n * 16);
  for (let i = 0; i < n; i++) {
    const p = i * 20, bf = data.readUInt32LE(p), tf = data.readUInt32LE(p+4), bl = data.readUInt32LE(p+8), tl = data.readUInt32LE(p+12), df = data.readUInt32LE(p+16);
    let idf = idfs.get(df);
    if (idf === undefined) { idf = Math.log(1 + (count - df + 0.5) / (df + 0.5)); if (idfs.size >= 65536) idfs.clear(); idfs.set(df, idf); }
    const score = (freq, len, avg) => freq ? idf * (freq * 2.2) / (freq + 1.2 * (1 - 0.75 + (0.75 * len) / (avg || 1))) : 0;
    out.writeDoubleLE(score(bf, bl, avgBody), i*16); out.writeDoubleLE(score(tf, tl, avgTitle), i*16+8);
  }
  fs.writeSync(1, out);
}
