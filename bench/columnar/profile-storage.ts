import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { crc32 } from "../../src/format/codec.js";
import type { Root } from "../../src/columnar/format.js";
/** Diagnostic only: validated R2 bytes are downloaded on demand and replayed
 * from local disk. This isolates CPU/allocation attribution from network time. */
export async function profileStorage(root: Root, dir: string, token: string) {
  await mkdir(dir, { recursive: true });
  const objects = new Map(
      root.objects.map((o) => [o.key ?? `${root.generation}/${o.name}`, o]),
    ),
    pending = new Map<
      string,
      Promise<{ data: Uint8Array; meta: Record<string, string> }>
    >();
  async function load(key: string, offset: number, length: number) {
    const descriptor = objects.get(key),
      cacheKey = createHash("sha256")
        .update(JSON.stringify(descriptor ? [key, offset, length] : [key]))
        .digest("hex"),
      cached = pending.get(cacheKey);
    if (cached) return cached;
    const task = (async () => {
      const metaFile = dir + "/" + cacheKey + ".json",
        dataFile = dir + "/" + cacheKey + ".bin";
      try {
        const saved = JSON.parse(await readFile(metaFile, "utf8")),
          data = await readFile(dataFile);
        if (createHash("sha256").update(data).digest("hex") !== saved.sha256)
          throw Error("Corrupt local profiling cache");
        return { data, meta: saved.meta };
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
      const response = await fetch(
        `https://work-search-cws-upload.phulin.workers.dev/${key}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            ...(descriptor
              ? { "x-offset": String(offset), "x-length": String(length) }
              : {}),
          },
          signal: AbortSignal.timeout(180000),
        },
      );
      if (
        !response.ok ||
        response.headers.get("x-sha256") !==
          (descriptor?.sha256 ?? key.split("/")[0]) ||
        response.headers.get("x-generation") !== key.split("/")[0]
      )
        throw Error("Profiling source identity mismatch " + response.status);
      const data = new Uint8Array(await response.arrayBuffer()),
        sha256 = createHash("sha256").update(data).digest("hex"),
        meta: Record<string, string> = {
          generation: key.split("/")[0],
          sha256: descriptor?.sha256 ?? sha256,
        };
      if (descriptor) {
        if (data.length !== length) throw Error("Truncated profiling page");
        meta.crc32 = response.headers.get("x-page-crc32") ?? "";
      } else {
        if (sha256 !== key.split("/")[0])
          throw Error("Profiling document group checksum mismatch");
        const checksums: number[] = [],
          view = new DataView(data.buffer);
        let at = 0,
          first = -1;
        while (at < data.length) {
          if (at + 64 > data.length || view.getUint32(at, true) !== 0x32504443)
            throw Error("Invalid profiling package group");
          const doc = view.getUint32(at + 4, true),
            n = view.getUint32(at + 56, true) + view.getUint32(at + 60, true);
          if (first < 0) first = doc;
          if (
            doc !== first + checksums.length ||
            n < 64 ||
            at + n > data.length
          )
            throw Error("Invalid profiling package coverage");
          checksums.push(crc32(data.subarray(at, at + n)));
          at += n;
        }
        meta.packageFirst = String(first);
        meta.packageEnd = String(first + checksums.length);
        meta.packageCrc32 = Buffer.from(
          Uint32Array.from(checksums).buffer,
        ).toString("base64");
      }
      await writeFile(dataFile, data);
      await writeFile(metaFile, JSON.stringify({ sha256, meta }));
      return { data, meta };
    })();
    pending.set(cacheKey, task);
    try {
      return await task;
    } finally {
      pending.delete(cacheKey);
    }
  }
  return async (request: Request) => {
    const key = new URL(request.url).pathname.slice(1),
      offset = Number(request.headers.get("offset")),
      length = Number(request.headers.get("length")),
      { data, meta } = await load(key, offset, length);
    return new Response(
      (objects.has(key)
        ? data
        : data.subarray(offset, offset + length)) as BodyInit,
      { headers: { "x-cws-meta": JSON.stringify(meta) } },
    );
  };
}
