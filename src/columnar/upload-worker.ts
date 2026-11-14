import { verifyPackageCoverage } from "./construction/coverage.js";
import {
  inspectPublication,
  publicationBody,
  publishBatch,
} from "./publication.js";
let activePublications = 0;
let activePublicationBytes = 0;
// Deployment transport and bounded publication checks; never a serving dependency.
export default {
  async fetch(
    request: Request,
    env: { INDEX: R2Bucket; UPLOAD_TOKEN: string },
  ) {
    if (
      !env.UPLOAD_TOKEN ||
      request.headers.get("authorization") !== `Bearer ${env.UPLOAD_TOKEN}`
    )
      return new Response("Not found", { status: 404 });
    const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (key === "__head-batch" && request.method === "POST") {
      try {
        return Response.json(
          await inspectPublication(env.INDEX, await request.json()),
        );
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    if (key === "__publish-batch" && request.method === "POST") {
      const size = Number(request.headers.get("x-raw-length"));
      if (!Number.isSafeInteger(size) || size < 5 || size > 8 * 1048576)
        return new Response("Invalid publication size", { status: 400 });
      if (
        activePublications >= 16 ||
        activePublicationBytes + size > 48 * 1048576
      )
        return new Response("Publication busy", { status: 503 });
      activePublications++;
      activePublicationBytes += size;
      try {
        return Response.json(
          await publishBatch(env.INDEX, await publicationBody(request)),
        );
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      } finally {
        activePublications--;
        activePublicationBytes -= size;
      }
    }
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
    if (key === "__delete-staging" && request.method === "POST") {
      const keys: unknown = await request.json();
      if (
        !Array.isArray(keys) ||
        keys.length < 1 ||
        keys.length > 1000 ||
        keys.some((key) => {
          if (typeof key !== "string") return true;
          const match = /^([a-f0-9]{64})\/stage-([a-f0-9]{64})\.bin$/.exec(key);
          return !match || match[1] !== match[2];
        }) ||
        new Set(keys).size !== keys.length
      )
        return new Response(
          "Only distinct content-addressed temporary streams",
          {
            status: 400,
          },
        );
      await env.INDEX.delete(keys);
      return Response.json({ deleted: keys.length });
    }
    if (
      !/^[a-f0-9]{64}\/(?:plan-\d+|stage-[a-f0-9]{64}|pairs-\d+|positions-\d+|presence-\d+|metadata)\.bin$/.test(
        key,
      )
    )
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
              "x-package-first": old.customMetadata?.packageFirst ?? "",
              "x-package-end": old.customMetadata?.packageEnd ?? "",
              "x-package-crc32": old.customMetadata?.packageCrc32 ?? "",
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
          "x-package-first": old.customMetadata?.packageFirst ?? "",
          "x-package-end": old.customMetadata?.packageEnd ?? "",
          "x-package-crc32": old.customMetadata?.packageCrc32 ?? "",
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
    const first = request.headers.get("x-package-first"),
      end = request.headers.get("x-package-end");
    if (
      (first !== null || end !== null) &&
      (!/^\d+$/.test(first ?? "") ||
        !/^\d+$/.test(end ?? "") ||
        !Number.isSafeInteger(Number(first)) ||
        !Number.isSafeInteger(Number(end)) ||
        Number(end) <= Number(first) ||
        !key.endsWith("/plan-0.bin") ||
        sha !== generation)
    )
      return new Response("Invalid package coverage", { status: 400 });
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
          ...(first === null ? {} : { packageFirst: first, packageEnd: end! }),
        },
      }),
      transfer,
    ]);
    return new Response("Stored");
  },
};
