import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
export const root = "work/demo-bench";
export const snapshot = JSON.parse(
  await readFile(root + "/snapshot.json", "utf8"),
);
export async function remote(path: string, body?: unknown) {
  const { url } = JSON.parse(await readFile(root + "/deployment.json", "utf8"));
  const { INTERNAL_TOKEN: token } = JSON.parse(
    await readFile("work/full-flp/secrets.json", "utf8"),
  );
  const r = await fetch(url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw Error(`Benchmark ${path}: ${r.status} ${await r.text()}`);
  return r;
}
await mkdir(root + "/ranges", { recursive: true });
const pending = new Map<string, Promise<Uint8Array>>();
const coverage = new Map<string, { offset: number; length: number }[]>();
for (const file of ["hydrate.json", "pages-hydrate.json"])
  try {
    const recorded = JSON.parse(await readFile(root + "/" + file, "utf8"));
    for (const row of recorded.rows)
      for (const event of row.trace.events) {
        if (
          event.type !== "r2" ||
          !Number.isSafeInteger(event.offset) ||
          !Number.isSafeInteger(event.length) ||
          event.length < 1
        )
          continue;
        if (!coverage.has(event.key)) coverage.set(event.key, []);
        const list = coverage.get(event.key)!;
        if (
          !list.some(
            (r) => r.offset === event.offset && r.length === event.length,
          )
        )
          list.push({ offset: event.offset, length: event.length });
      }
  } catch {}
export function rangeName(key: string, offset: number, length: number) {
  return createHash("sha256")
    .update(JSON.stringify([key, offset, length]))
    .digest("hex");
}
export async function range(
  key: string,
  offset: number,
  length: number,
  hydrate: boolean,
): Promise<Uint8Array> {
  const name = rangeName(key, offset, length),
    path = root + "/ranges/" + name;
  try {
    return await readFile(path);
  } catch {}
  // Warm page coalescing can request a different union of already mirrored
  // ranges. Assemble those bytes without a network fallback during timing.
  const intervals = coverage.get(key) ?? [],
    pieces: Uint8Array[] = [];
  let cursor = offset;
  while (cursor < offset + length) {
    const candidate = intervals
      .filter((r) => r.offset <= cursor && r.offset + r.length > cursor)
      .sort((a, b) => b.offset + b.length - (a.offset + a.length))[0];
    if (!candidate) break;
    try {
      const b = await readFile(
        root + "/ranges/" + rangeName(key, candidate.offset, candidate.length),
      );
      const end = Math.min(
        offset + length,
        candidate.offset + candidate.length,
      );
      pieces.push(
        b.subarray(cursor - candidate.offset, end - candidate.offset),
      );
      cursor = end;
    } catch {
      break;
    }
  }
  if (cursor === offset + length) return Buffer.concat(pieces);
  if (!hydrate)
    throw Error(`Unhydrated benchmark range ${key} ${offset} ${length}`);
  if (pending.has(name)) return pending.get(name)!;
  const task = (async () => {
    const parts: Uint8Array[] = [];
    for (let cursor = 0; cursor < length; cursor += 4 * 1048576) {
      const r = await remote(
        "/read?" +
          new URLSearchParams({
            key,
            offset: String(offset + cursor),
            length: String(Math.min(4 * 1048576, length - cursor)),
          }),
      );
      const b = new Uint8Array(await r.arrayBuffer());
      if (b.length !== Math.min(4 * 1048576, length - cursor))
        throw Error("Truncated benchmark mirror");
      if (
        /^[a-f0-9]{64}\//.test(key) &&
        r.headers.get("x-generation") !== key.split("/")[0]
      )
        throw Error("Mirror generation mismatch");
      parts.push(b);
    }
    const bytes = Buffer.concat(parts);
    await writeFile(path, bytes);
    return bytes;
  })();
  pending.set(name, task);
  try {
    return await task;
  } finally {
    pending.delete(name);
  }
}
export async function object(key: string) {
  const r = await remote(
    "/read?" + new URLSearchParams({ key, offset: "0", length: "1" }),
  );
  await r.arrayBuffer();
  return range(key, 0, Number(r.headers.get("x-object-size")), true);
}
