import { open, readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { benchmarkToken } from "./token.js";
const upload = process.argv.includes("--upload"),
  manifestPath = "bench/columnar/ci-input.json",
  root = "work/full-flp",
  url = "https://work-search-cws-upload.phulin.workers.dev",
  token = await benchmarkToken();
await mkdir(root, { recursive: true });
const authorization = `Bearer ${token}`;
if (upload) {
  const source = JSON.parse(
      await readFile(
        root + "/opinions-2026-09-30.csv.bz2.download.json",
        "utf8",
      ),
    ),
    file = await open(root + "/metadata.sqlite", "r"),
    hash = createHash("sha256"),
    scope = createHash("sha256")
      .update("CWS1 CI pinned metadata 2026-09-30")
      .digest("hex"),
    chunks = [];
  try {
    for (let offset = 0; ; offset += 64 * 1048576) {
      const buffer = Buffer.alloc(64 * 1048576),
        { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      const data = buffer.subarray(0, bytesRead),
        sha256 = createHash("sha256").update(data).digest("hex"),
        key = `${sha256}/stage-${scope}.bin`;
      hash.update(data);
      const head = await fetch(`${url}/${key}`, {
        method: "HEAD",
        headers: { authorization },
      });
      if (head.status !== 200) {
        const body = gzipSync(data, { level: 1 }),
          response = await fetch(`${url}/${key}`, {
            method: "PUT",
            headers: {
              authorization,
              "x-sha256": sha256,
              "x-raw-length": String(bytesRead),
              "content-length": String(body.length),
            },
            body,
          });
        if (!response.ok)
          throw Error(
            "CI metadata upload " +
              response.status +
              " " +
              (await response.text()),
          );
      } else if (
        head.headers.get("x-sha256") !== sha256 ||
        Number(head.headers.get("content-length")) !== bytesRead
      )
        throw Error("CI metadata immutable mismatch");
      chunks.push({ key, sha256, size: bytesRead });
      console.log("Pinned metadata chunk", chunks.length);
    }
  } finally {
    await file.close();
  }
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        source: {
          url: source.url,
          size: source.size,
          etag: source.etag,
          complete: true,
        },
        metadata: { sha256: hash.digest("hex"), chunks },
      },
      null,
      2,
    ),
  );
} else {
  const pinned = JSON.parse(await readFile(manifestPath, "utf8")),
    file = await open(root + "/metadata.sqlite", "w"),
    hash = createHash("sha256");
  try {
    for (const chunk of pinned.metadata.chunks) {
      const response = await fetch(`${url}/${chunk.key}`, {
        headers: { authorization },
      });
      if (!response.ok) throw Error("CI metadata GET " + response.status);
      const data = Buffer.from(await response.arrayBuffer());
      if (
        data.length !== chunk.size ||
        createHash("sha256").update(data).digest("hex") !== chunk.sha256
      )
        throw Error("CI metadata checksum mismatch");
      hash.update(data);
      await file.write(data);
    }
  } finally {
    await file.close();
  }
  if (hash.digest("hex") !== pinned.metadata.sha256)
    throw Error("CI full metadata checksum mismatch");
  await writeFile(
    root + "/opinions-2026-09-30.csv.bz2.download.json",
    JSON.stringify(pinned.source),
  );
}
