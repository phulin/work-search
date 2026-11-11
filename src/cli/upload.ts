import { createHmac, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const digest = (x: Uint8Array | string) =>
  createHash("sha256").update(x).digest("hex");
const hmac = (k: Uint8Array | string, x: string) =>
  createHmac("sha256", k).update(x).digest();
// Minimal SigV4 for R2 S3 HEAD/PUT, no SDK or credentials in the Worker.
export async function signedRequest(
  method: string,
  url: URL,
  body: Uint8Array,
  extra: Record<string, string> = {},
) {
  const access = process.env.R2_ACCESS_KEY_ID,
    secret = process.env.R2_SECRET_ACCESS_KEY;
  if (!access || !secret)
    throw new Error("Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY for upload");
  const time = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
    day = time.slice(0, 8),
    scope = `${day}/auto/s3/aws4_request`,
    payload = digest(body);
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-date": time,
    "x-amz-content-sha256": payload,
    ...extra,
  };
  const names = Object.keys(headers).sort(),
    signed = names.join(";");
  const canonical = [
    method,
    url.pathname,
    "",
    names.map((n) => `${n}:${headers[n].trim()}\n`).join(""),
    signed,
    payload,
  ].join("\n");
  const key = hmac(
    hmac(hmac(hmac("AWS4" + secret, day), "auto"), "s3"),
    "aws4_request",
  );
  const signature = hmac(
    key,
    ["AWS4-HMAC-SHA256", time, scope, digest(canonical)].join("\n"),
  ).toString("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
  return fetch(url, {
    method,
    headers,
    body: method === "PUT" ? (body as BodyInit) : undefined,
  });
}
export async function upload(out: string, bucket: string, manifest: any) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) throw new Error("Set CLOUDFLARE_ACCOUNT_ID for upload");
  for (const o of manifest.objects) {
    const url = new URL(
        `https://${account}.r2.cloudflarestorage.com/${encodeURIComponent(bucket)}/${o.key.split("/").map(encodeURIComponent).join("/")}`,
      ),
      empty = new Uint8Array();
    const existing = await signedRequest("HEAD", url, empty);
    if (existing.ok) {
      if (
        existing.headers.get("x-amz-meta-generation") !== manifest.generation ||
        existing.headers.get("x-amz-meta-sha256") !== o.sha256 ||
        Number(existing.headers.get("content-length")) !== o.size
      )
        throw new Error("Immutable object conflict: " + o.key);
      continue;
    }
    if (existing.status !== 404)
      throw new Error(`R2 HEAD failed: ${existing.status}`);
    const response = await signedRequest(
      "PUT",
      url,
      await readFile(join(out, "objects", o.key)),
      {
        "x-amz-meta-generation": manifest.generation,
        "x-amz-meta-sha256": o.sha256,
        "content-type": "application/octet-stream",
        "if-none-match": "*",
      },
    );
    if (!response.ok) throw new Error(`R2 PUT failed: ${response.status}`);
    console.log("Uploaded " + o.key);
  }
}
