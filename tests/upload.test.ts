import { it, expect, vi, afterEach } from "vitest";
import { upload, signedRequest } from "../src/cli/upload.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function credentials() {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "test-account");
  vi.stubEnv("R2_ACCESS_KEY_ID", "test-access");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret");
}
it("signs conditional S3 requests and generation metadata", async () => {
  credentials();
  let captured: RequestInit | undefined;
  vi.stubGlobal("fetch", async (_: URL, init: RequestInit) => {
    captured = init;
    return new Response("");
  });
  await signedRequest(
    "PUT",
    new URL("https://test.r2.cloudflarestorage.com/b/g/postings-0.bin"),
    new Uint8Array([1, 2]),
    { "if-none-match": "*", "x-amz-meta-generation": "g" },
  );
  const h = captured!.headers as Record<string, string>;
  expect(h.authorization).toMatch(
    /^AWS4-HMAC-SHA256 Credential=test-access\/\d{8}\/auto\/s3\/aws4_request/,
  );
  expect(h.authorization).toContain("if-none-match");
  expect(h.authorization).toContain("x-amz-meta-generation");
  expect(h["x-amz-content-sha256"]).toHaveLength(64);
  expect(h["if-none-match"]).toBe("*");
});
it("skips only verified immutable objects and rejects mismatches", async () => {
  credentials();
  const m = {
    generation: "g",
    objects: [{ key: "g/postings-0.bin", sha256: "expected", size: 12 }],
  };
  const fetch = vi.fn(
    async () =>
      new Response(null, {
        headers: {
          "x-amz-meta-generation": "g",
          "x-amz-meta-sha256": "expected",
          "content-length": "12",
        },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  await upload("/unused", "bucket", m);
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockImplementation(
    async () =>
      new Response(null, { headers: { "x-amz-meta-generation": "wrong" } }),
  );
  await expect(upload("/unused", "bucket", m)).rejects.toThrow(
    "Immutable object conflict",
  );
});
