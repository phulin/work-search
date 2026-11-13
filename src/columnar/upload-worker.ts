import { verifyPackageCoverage } from "./construction/coverage.js";
// Deployment transport and bounded publication checks; never a serving dependency.
export default {
  async fetch(
    request: Request,
    env: { INDEX: R2Bucket; UPLOAD_TOKEN: string },
  ) {
    if (request.headers.get("authorization") !== `Bearer ${env.UPLOAD_TOKEN}`)
      return new Response("Not found", { status: 404 });
    const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (/^[a-f0-9]{64}\/root\.json$/.test(key) && request.method === "GET") {
      const object = await env.INDEX.get(key);
      return new Response(object?.body ?? "Missing published generation", {
        status: object ? 200 : 404,
        headers: { "cache-control": "no-store" },
      });
    }
    if (key === "__verify-packages" && request.method === "POST") {
      try {
        return Response.json(
          await verifyPackageCoverage(env.INDEX, await request.json()),
        );
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    if (!/^[a-f0-9]{64}\/(?:plan-\d+|stage-[a-f0-9]{64})\.bin$/.test(key))
      return new Response("Invalid key", { status: 400 });
    const generation = key.split("/")[0],
      old = await env.INDEX.head(key);
    if (request.method === "HEAD")
      return new Response(null, {
        status: old ? 200 : 404,
        headers: old
          ? {
              "content-length": String(old.size),
              "x-sha256": old.customMetadata?.sha256 ?? "",
              "x-generation": old.customMetadata?.generation ?? "",
              "x-page-crc32": old.customMetadata?.crc32 ?? "",
            }
          : undefined,
      });
    if (request.method === "GET") {
      if (!old) return new Response("Missing object", { status: 404 });
      const offset = Number(request.headers.get("x-offset") ?? 0),
        length = Number(request.headers.get("x-length") ?? old.size);
      if (
        !Number.isInteger(offset) ||
        !Number.isInteger(length) ||
        offset < 0 ||
        length < 1 ||
        offset + length > old.size
      )
        return new Response("Invalid range", { status: 400 });
      const object = await env.INDEX.get(key, { range: { offset, length } });
      return new Response(object!.body, {
        headers: {
          "content-length": String(length),
          "x-generation": generation,
          "x-sha256": old.customMetadata?.sha256 ?? "",
          "x-page-crc32": old.customMetadata?.crc32 ?? "",
        },
      });
    }
    if (request.method === "DELETE") {
      if (!/\/stage-[a-f0-9]{64}\.bin$/.test(key))
        return new Response("Only temporary build streams can be deleted", {
          status: 400,
        });
      if (!old) return new Response(null, { status: 204 });
      if (request.headers.get("x-sha256") !== old.customMetadata?.sha256)
        return new Response("Digest mismatch", { status: 409 });
      await env.INDEX.delete(key);
      return new Response(null, { status: 204 });
    }
    const sha = request.headers.get("x-sha256") ?? "",
      size = Number(request.headers.get("x-raw-length")),
      crc32 = request.headers.get("x-page-crc32");
    if (
      request.method !== "PUT" ||
      !/^[a-f0-9]{64}$/.test(sha) ||
      !Number.isInteger(size) ||
      size < 1 ||
      size > 64 * 1048576 ||
      !request.body
    )
      return new Response("Invalid upload", { status: 400 });
    if (
      crc32 &&
      (!/^[A-Za-z0-9+/]+={0,2}$/.test(crc32) ||
        atob(crc32).length !== Math.ceil(size / 262144) * 4)
    )
      return new Response("Invalid checksum directory", { status: 400 });
    if (old)
      return new Response(
        old.size === size &&
          old.customMetadata?.sha256 === sha &&
          old.customMetadata?.generation === generation
          ? "Exists"
          : "Immutable conflict",
        {
          status:
            old.size === size &&
            old.customMetadata?.sha256 === sha &&
            old.customMetadata?.generation === generation
              ? 200
              : 409,
        },
      );
    const fixed = new FixedLengthStream(size),
      transfer = (
        request.headers.get("x-transport") === "raw"
          ? request.body
          : request.body.pipeThrough(new DecompressionStream("gzip"))
      ).pipeTo(fixed.writable);
    await Promise.all([
      env.INDEX.put(key, fixed.readable, {
        sha256: sha,
        customMetadata: {
          generation,
          sha256: sha,
          ...(crc32 ? { crc32 } : {}),
        },
      }),
      transfer,
    ]);
    return new Response("Stored");
  },
};
