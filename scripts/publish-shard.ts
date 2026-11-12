import {
  readFile,
  writeFile,
  copyFile,
  mkdir,
  rm,
  rename,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { deploy } from "./deploy-demo.js";
import { parallel } from "../src/storage/types.js";
import { openIndex } from "../src/format/paged.js";
const root = "work/full-flp",
  out = process.argv[2],
  id = Number(process.argv[3]),
  preview = process.argv.includes("--preview");
if (!out || !Number.isInteger(id) || id < 0)
  throw Error("Usage: publish-shard index-directory shard-id [--preview]");
const { INTERNAL_TOKEN: token } = JSON.parse(
    await readFile(root + "/secrets.json", "utf8"),
  ),
  { url } = JSON.parse(await readFile(root + "/deployment.json", "utf8"));
const manifest = JSON.parse(await readFile(out + "/manifest.json", "utf8")),
  binary = await readFile(out + "/bundle.bin");
if (
  createHash("sha256").update(binary).digest("hex") !== manifest.bundleSha256 ||
  openIndex(binary).generation !== manifest.generation
)
  throw Error("Invalid bundle manifest");
await writeFile(out + "/archive-manifest.bin", JSON.stringify(manifest));
const manifestBytes = await readFile(out + "/archive-manifest.bin");
const uploads = [
  ...manifest.objects,
  {
    key: manifest.generation + "/bundle-0.bin",
    size: binary.length,
    sha256: manifest.bundleSha256,
    file: out + "/bundle.bin",
  },
  {
    key: manifest.generation + "/manifest-0.bin",
    size: manifestBytes.length,
    sha256: createHash("sha256").update(manifestBytes).digest("hex"),
    file: out + "/archive-manifest.bin",
  },
];
const viewer = await readFile(
  out + "/viewer/viewer-manifest.json",
  "utf8",
).then(JSON.parse, () => null);
if (viewer)
  for (const o of viewer.objects)
    uploads.push({
      key: manifest.generation + "/" + o.name,
      size: o.size,
      sha256: o.sha256,
      file: out + "/viewer/" + o.name,
    });
await parallel(uploads, 3, async (o: any) => {
  const file = o.file ?? out + "/objects/" + o.key;
  const digest = createHash("sha256");
  for await (const b of createReadStream(file)) digest.update(b);
  if (digest.digest("hex") !== o.sha256)
    throw Error("Object checksum mismatch");
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(
      url + "/__upload/" + encodeURIComponent(o.key),
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-length": String(o.size),
          "x-sha256": o.sha256,
        },
        body: createReadStream(file),
        duplex: "half",
      } as any,
    );
    if (response.ok) {
      console.log("Uploaded", o.key, o.size);
      return;
    }
    if (attempt === 4)
      throw Error(`Upload failed ${response.status}: ${await response.text()}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
});
const lock = root + "/publish.lock";
for (;;) {
  try {
    await mkdir(lock);
    await writeFile(lock + "/pid", String(process.pid));
    break;
  } catch {
    try {
      const pid = Number(await readFile(lock + "/pid", "utf8"));
      try {
        process.kill(pid, 0);
      } catch {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
}
try {
  const worker = `work-search-flp-shard-${String(id).padStart(3, "0")}`,
    saved = await readFile("data/bundle.bin");
  try {
    await copyFile(out + "/bundle.bin", "data/bundle.bin");
    await deploy(worker, "demo/shard.ts", { SHARD_ID: String(id) });
  } finally {
    await writeFile("data/bundle.bin", saved);
  }
  let state: any = { shards: {} };
  try {
    state = JSON.parse(await readFile(root + "/published.json", "utf8"));
  } catch {}
  const inputSha256 = preview
    ? undefined
    : await readFile(
        `${root}/batches/${String(id).padStart(5, "0")}.json`,
        "utf8",
      ).then(
        (s) => JSON.parse(s).sha256,
        () => undefined,
      );
  state.shards[id] = {
    id,
    worker,
    generation: manifest.generation,
    documents: manifest.documents,
    preview,
    viewerAvailable: !!viewer,
    inputSha256,
  };
  const group = Math.floor(id / 32),
    members = Object.values(state.shards)
      .filter((s: any) => Math.floor(s.id / 32) === group)
      .sort((a: any, b: any) => a.id - b.id) as any[];
  await deploy(
    `work-search-flp-group-${String(group).padStart(3, "0")}`,
    "demo/gateway.ts",
    {
      ROLE: "router",
      CHILDREN: JSON.stringify(
        members.map((s, i) => ({
          binding: `CHILD_${i}`,
          min: s.id,
          max: s.id,
        })),
      ),
    },
    members.map((s, i) => ({ binding: `CHILD_${i}`, service: s.worker })),
  );
  const groups = [
    ...new Set(
      Object.values(state.shards).map((s: any) => Math.floor(s.id / 32)),
    ),
  ].sort((a, b) => a - b);
  let oldGroups: number[] = [];
  try {
    oldGroups = JSON.parse(await readFile(root + "/groups.json", "utf8"));
  } catch {}
  if (JSON.stringify(groups) !== JSON.stringify(oldGroups)) {
    await deploy(
      "work-search-demo",
      "demo/gateway.ts",
      {
        ROLE: "root",
        CHILDREN: JSON.stringify(
          groups.map((g, i) => ({
            binding: `CHILD_${i}`,
            min: g * 32,
            max: g * 32 + 31,
          })),
        ),
      },
      groups.map((g, i) => ({
        binding: `CHILD_${i}`,
        service: `work-search-flp-group-${String(g).padStart(3, "0")}`,
      })),
    );
    await writeFile(root + "/groups.json", JSON.stringify(groups));
  }
  await writeFile(root + "/published.tmp", JSON.stringify(state, null, 2));
  await rename(root + "/published.tmp", root + "/published.json");
  const shards = Object.values(state.shards) as any[],
    documents = shards.reduce((n, s) => n + s.documents, 0);
  const response = await fetch(url + "/__status", {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({
      documents,
      partitions: shards.length,
      viewerDocuments: shards
        .filter((s) => s.viewerAvailable)
        .reduce((n, s) => n + s.documents, 0),
      complete: false,
      phase: preview
        ? "Sample preview · full official import in progress"
        : "Full official import in progress",
      snapshot: "2026-09-30",
      note: preview
        ? "Preview currently uses the earlier 100k COLD Cases sample; the official snapshot is downloading."
        : "The full snapshot is being imported; only published partitions are searchable.",
    }),
  });
  if (!response.ok) throw Error("Status update failed");
  console.log("Published", id, documents, "searchable opinions", url);
} finally {
  await rm(lock, { recursive: true, force: true });
}
