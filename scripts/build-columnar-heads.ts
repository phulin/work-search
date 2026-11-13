import { readFile, writeFile, open } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { leaves } from "../src/columnar/search.js";
import { OfflineObjects } from "../src/columnar/offline.js";
import { benchmarkToken } from "../bench/columnar/token.js";
import { Reader, Memory } from "../src/columnar/storage.js";
import {
  decodeScores,
  refAt,
  view,
  concat,
  type Root,
  type Branch,
} from "../src/columnar/format.js";
import { headKey, type HeadRoot } from "../src/columnar/heads.js";
const dir = process.argv[2];
if (!dir)
  throw Error(
    "Usage: yarn node --import tsx scripts/build-columnar-heads.ts INDEX_DIR [TERMS=64]",
  );
const root: Root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
  memory = new Memory(),
  objects = new OfflineObjects(
    dir,
    root,
    process.env.CWS_REMOTE_URL
      ? { url: process.env.CWS_REMOTE_URL, token: await benchmarkToken() }
      : undefined,
  );
const source = objects.source;
const reader = new Reader(root, source, memory),
  parts: Uint8Array[] = [],
  heads: HeadRoot = {
    format: "CWH1",
    baseGeneration: root.generation,
    depth: 100,
    entries: {},
  };
let offset = 0;
type Row = {
  doc: number;
  score: number;
  branch: Branch;
  row: number;
  body: boolean;
};
const append = (data: Uint8Array) => {
  const start = offset;
  parts.push(data);
  offset += data.length;
  return start;
};
try {
  for (const [term, plan] of Object.entries(root.hot)
    .sort((a, b) => b[1].df - a[1].df || a[0].localeCompare(b[0]))
    .slice(0, Number(process.argv[3] ?? 64))) {
    const configs = [
      ["body", 0],
      ["all", 0],
      ["all", 2],
      ["all", 20],
      ["title", 0],
      ["title", 2],
      ["title", 20],
    ] as const;
    const top = configs.map(() => [] as Row[]),
      bs = await leaves(reader, plan.tree, 0, root.count);
    for (const branch of bs) {
      const s = reader.decoded(
        branch.score,
        await reader.read(branch.score),
        decodeScores,
      );
      for (let r = 0; r < s.docs.length; r++)
        for (let c = 0; c < configs.length; c++) {
          const [field, boost] = configs[c];
          if (field !== "all" && !s[field][r]) continue;
          const score =
              (field !== "title" ? s.b.getFloat64(r * 8, true) : 0) +
              (field !== "body" ? boost * s.t.getFloat64(r * 8, true) : 0),
            a = top[c],
            doc = s.docs[r];
          if (
            a.length === heads.depth &&
            (score < a.at(-1)!.score ||
              (score === a.at(-1)!.score && doc > a.at(-1)!.doc))
          )
            continue;
          a.push({ doc, score, branch, row: r, body: !!s.body[r] });
          a.sort((a, b) => b.score - a.score || a.doc - b.doc);
          if (a.length > heads.depth) a.pop();
        }
    }
    for (let c = 0; c < configs.length; c++) {
      const a = top[c],
        numeric = new Uint8Array(a.length * 12),
        v = view(numeric),
        text = [];
      for (let i = 0; i < a.length; i++) {
        const h = a[i],
          loc = view(await reader.read(h.branch.locators)),
          p = h.row * 36,
          record = await reader.json(refAt(loc, p)),
          passage = await reader.json(refAt(loc, p + 24));
        const tokens =
            passage.text
              .normalize("NFKC")
              .toLowerCase()
              .match(/[\p{L}\p{N}]+/gu) ?? [],
          at = tokens.indexOf(term),
          from = at >= 0 ? Math.max(0, passage.starts[at] - 160) : 0,
          end = at >= 0 ? passage.ends[at] + 240 : 400;
        let snippet =
          (passage.first || from ? "…" : "") +
          passage.text.slice(from, end).trim() +
          (end < passage.text.length ? "…" : "");
        if (configs[c][0] === "title" || !h.body)
          snippet = String(record.title ?? "").slice(0, 400);
        v.setUint32(i * 12, h.doc, true);
        v.setFloat64(i * 12 + 4, h.score, true);
        text.push({
          id: record.id,
          title: record.title,
          metadata: record.metadata,
          snippet,
        });
      }
      const compressed = gzipSync(JSON.stringify(text)),
        start = append(numeric),
        textOffset = append(compressed);
      heads.entries[headKey(term, configs[c][0], configs[c][1])] = {
        offset: start,
        length: numeric.length,
        count: a.length,
        text: textOffset,
        textLength: compressed.length,
      };
    }
    console.log("Certified heads", term, plan.df, offset);
  }
  const data = concat(parts);
  if (data.length > 16 * 1048576) throw Error("Bundled head budget exceeded");
  await writeFile(dir + "/heads.bin", data);
  await writeFile(dir + "/heads-root.json", JSON.stringify(heads));
  await writeFile(
    dir + "/heads-manifest.json",
    JSON.stringify(
      {
        baseGeneration: root.generation,
        selection:
          "64 highest corpus document frequencies; exact top100 for body and all/title boosts 0,2,20",
        sha256: createHash("sha256").update(data).digest("hex"),
        bytes: data.length,
      },
      null,
      2,
    ),
  );
} finally {
  await objects.close();
}
