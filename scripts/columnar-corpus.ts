import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rename, writeFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parse } from "csv-parse";
import { Parser } from "htmlparser2";
const [output, maximum = "1000000", root = "work/full-flp"] =
  process.argv.slice(2);
if (!output)
  throw Error(
    "Usage: yarn node --import tsx scripts/columnar-corpus.ts OUT.jsonl [MAX_DOCS] [SNAPSHOT_DIR]",
  );
const limit = Number(maximum),
  snapshot = root + "/opinions-2026-09-30.csv.bz2",
  state = JSON.parse(await readFile(snapshot + ".download.json", "utf8"));
if (!state.complete)
  throw Error("Official source snapshot download is incomplete");
const db = new DatabaseSync(root + "/metadata.sqlite", { readOnly: true }),
  lookup = db.prepare("SELECT title,date,status FROM cases WHERE id=?");
await mkdir(dirname(output), { recursive: true });
const stdout = output === "-",
  out = stdout ? process.stdout : createWriteStream(output + ".tmp"),
  hash = createHash("sha256"),
  start = performance.now();
const remote = process.env.CWS_SNAPSHOT_URL,
  child = spawn("bzip2", remote ? ["-dc"] : ["-dc", snapshot], {
    stdio: [remote ? "pipe" : "ignore", "pipe", "inherit"],
  }),
  csv = parse({ columns: true, escape: "\\", max_record_size: 128 * 1048576 });
child.stdout!.pipe(csv);
let sourceFinished: Promise<void> | undefined;
if (remote) {
  if (remote !== state.url)
    throw Error("Snapshot URL must match pinned provenance");
  const response = await fetch(remote, { headers: { "if-match": state.etag } });
  if (
    !response.ok ||
    response.headers.get("etag") !== state.etag ||
    Number(response.headers.get("content-length")) !== state.size
  )
    throw Error("Remote snapshot identity mismatch");
  const stream = Readable.fromWeb(response.body as any);
  let received = 0;
  stream.on("data", (b: Buffer) => {
    received += b.length;
  });
  stream.pipe(child.stdin!);
  sourceFinished = new Promise<void>((ok, no) => {
    stream.once("error", no);
    stream.once("end", () =>
      received === state.size ? ok() : no(Error("Truncated remote snapshot")),
    );
  });
  sourceFinished.catch((e) => csv.destroy(e));
  child.stdin!.on("error", () => stream.destroy());
}
const stop = () => {
  child.kill("SIGTERM");
  csv.destroy(Error("Corpus extraction interrupted"));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
const breaks = new Set([
    "p",
    "div",
    "br",
    "li",
    "tr",
    "h1",
    "h2",
    "table",
    "section",
    "blockquote",
    "pre",
  ]),
  closeBreaks = new Set([...breaks].filter((t) => t !== "br"));
function body(row: Record<string, string>) {
  for (const field of [
    "plain_text",
    "html_with_citations",
    "html",
    "html_lawbox",
    "html_columbia",
    "html_anon_2020",
    "xml_harvard",
    "xml_scan",
  ]) {
    const value = row[field];
    if (!value || value === "\\N" || !value.trim()) continue;
    if (field === "plain_text") return { text: value, field };
    let skip = 0;
    const parts: string[] = [];
    const parser = new Parser(
      {
        onopentag(name) {
          if (name === "script" || name === "style") skip++;
          if (breaks.has(name)) parts.push("\n");
        },
        onclosetag(name, implied) {
          if (implied) return;
          if (name === "script" || name === "style")
            skip = Math.max(0, skip - 1);
          if (closeBreaks.has(name)) parts.push("\n");
        },
        ontext(text) {
          if (!skip) parts.push(text);
        },
      },
      { decodeEntities: true, recognizeSelfClosing: true },
    );
    parser.end(value);
    const text = parts.join("");
    if (text.trim()) return { text, field };
  }
}
let count = 0,
  rows = 0,
  skipped = 0;
try {
  for await (const row of csv) {
    rows++;
    const b = body(row);
    if (!b) {
      skipped++;
      continue;
    }
    const cid = Number(row.cluster_id),
      opinion = Number(row.id),
      meta = lookup.get(cid) as any;
    const doc = {
      id: `courtlistener-opinion:${opinion}`,
      title: meta?.title ?? `Opinion ${opinion}`,
      body: b.text,
      metadata: {
        opinion_id: opinion,
        cluster_id: cid,
        date_filed: meta?.date ?? null,
        precedential_status: meta?.status ?? null,
        text_field: b.field,
        url: `https://www.courtlistener.com/opinion/${cid}/`,
        snapshot: "2026-09-30",
      },
    };
    const line = JSON.stringify(doc) + "\n";
    hash.update(line);
    if (!out.write(line)) await once(out, "drain");
    if (++count % 10000 === 0)
      (stdout ? console.error : console.log)(
        "corpus",
        count,
        "seconds",
        Math.round((performance.now() - start) / 1000),
      );
    if (count === limit) break;
  }
  if (count < limit && remote) await sourceFinished;
  out.end();
  await once(out, "finish");
  if (!stdout) await rename(output + ".tmp", output);
  await writeFile(
    stdout
      ? (process.env.CWS_CORPUS_MANIFEST ??
          "work/columnar-corpus-full.manifest.json")
      : output + ".manifest.json",
    JSON.stringify(
      {
        snapshot,
        sourceDownload: state,
        extractor: "scripts/columnar-corpus.ts",
        documents: count,
        sourceRows: rows,
        skippedEmpty: skipped,
        sha256: hash.digest("hex"),
        elapsedMs: performance.now() - start,
        limit,
      },
      null,
      2,
    ),
  );
} finally {
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  csv.destroy();
  child.kill("SIGTERM");
  db.close();
}
