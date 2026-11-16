// Temporary maintenance Worker. The client supplies only the reviewed allowlist;
// a bundled hash table independently rejects every retained serving/source key.
export function cleanupWorker(protectedHashes: Uint8Array) {
  function protectedKey(hash: Uint8Array) {
    let lo = 0,
      hi = protectedHashes.length / 32;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      let cmp = 0;
      for (let i = 0; i < 32 && !cmp; i++)
        cmp = hash[i] - protectedHashes[mid * 32 + i];
      if (!cmp) return true;
      if (cmp > 0) lo = mid + 1;
      else hi = mid;
    }
    return false;
  }
  return {
    async fetch(
      request: Request,
      env: { INTERNAL_TOKEN: string; INDEX: R2Bucket },
    ) {
      if (
        request.headers.get("authorization") !== `Bearer ${env.INTERNAL_TOKEN}`
      )
        return new Response("Not found", { status: 404 });
      if (request.method !== "POST")
        return new Response("POST only", { status: 405 });
      const keys: unknown = await request.json();
      if (
        !Array.isArray(keys) ||
        !keys.length ||
        keys.length > 1000 ||
        new Set(keys).size !== keys.length ||
        keys.some(
          (k) =>
            typeof k !== "string" ||
            !/^(?:[a-f0-9]{64}\/(?:(?:plan-\d+|stage-[a-f0-9]{64})\.bin|root\.json)|cws-fresh-v3\/[a-z0-9-]+\/[a-z0-9-]+\.json)$/.test(
              k,
            ),
        )
      )
        return new Response("Invalid deletion batch", { status: 400 });
      const hashes = await Promise.all(
        keys.map(
          async (key) =>
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(key),
              ),
            ),
        ),
      );
      if (hashes.some(protectedKey))
        return new Response("Retained key", { status: 409 });
      await env.INDEX.delete(keys);
      return Response.json({ requested: keys.length });
    },
  };
}
