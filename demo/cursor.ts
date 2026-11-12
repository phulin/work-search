const enc = new TextEncoder(),
  dec = new TextDecoder();
const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64 = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
const key = (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
export async function encodeCursor(payload: unknown, secret: string) {
  const data = enc.encode(JSON.stringify(payload)),
    signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", await key(secret), data),
    );
  return b64(data) + "." + b64(signature);
}
export async function decodeCursor(cursor: string, secret: string) {
  if (cursor.length > 200000) throw Error("Invalid cursor");
  const parts = cursor.split(".");
  if (parts.length !== 2) throw Error("Invalid cursor");
  const [data, sig] = parts;
  const bytes = unb64(data);
  if (
    !sig ||
    !(await crypto.subtle.verify("HMAC", await key(secret), unb64(sig), bytes))
  )
    throw Error("Invalid cursor");
  const value = JSON.parse(dec.decode(bytes));
  if (value.expires < Date.now())
    throw Error("Search expired; start a new search");
  return value;
}
