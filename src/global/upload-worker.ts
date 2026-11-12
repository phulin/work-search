// Deploy separately so a complete immutable generation uploads before search switches.
export default {
  async fetch(
    request: Request,
    env: { INDEX: R2Bucket; UPLOAD_TOKEN: string },
  ) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("Uploader ready");
    if (
      !["PUT", "HEAD"].includes(request.method) ||
      request.headers.get("authorization") !== `Bearer ${env.UPLOAD_TOKEN}`
    )
      return new Response("Not found", { status: 404 });
    const key = decodeURIComponent(url.pathname.slice(1));
    if (!/^[a-f0-9]{64}\/(?:plan|page)-\d+\.bin$/.test(key))
      return new Response("Invalid immutable key", { status: 400 });
    if (request.method === "HEAD") {
      const old = await env.INDEX.head(key);
      return new Response(null, {
        status: old ? 200 : 404,
        headers: old
          ? {
              "content-length": String(old.size),
              "x-sha256": old.customMetadata?.sha256 ?? "",
              "x-generation": old.customMetadata?.generation ?? "",
            }
          : undefined,
      });
    }
    const sha = request.headers.get("x-sha256") ?? "",
      size = Number(request.headers.get("content-length")),
      generation = key.split("/")[0];
    if (
      !/^[a-f0-9]{64}$/.test(sha) ||
      !Number.isInteger(size) ||
      size < 1 ||
      size > 64 * 1048576
    )
      return new Response("Invalid object metadata", { status: 400 });
    const old = await env.INDEX.head(key);
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
    await env.INDEX.put(key, request.body, {
      customMetadata: { generation, sha256: sha },
    });
    return new Response("Stored");
  },
};
