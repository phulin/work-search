import { readFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { request as httpsRequest, Agent } from "node:https";
import type { AuxiliaryObject } from "./columnar-serving.js";
import {
  MAX_PUBLICATION_BYTES,
  type PublicationRecord,
} from "../src/columnar/publication.js";
const compress = promisify(gzip);
const largeConcurrency = Number(process.env.CWS_UPLOAD_CONCURRENCY ?? 4);
if (
  !Number.isInteger(largeConcurrency) ||
  largeConcurrency < 1 ||
  largeConcurrency > 16
)
  throw Error("Publication concurrency must be 1..16");
const agent = new Agent({
  keepAlive: true,
  maxSockets: Math.max(12, largeConcurrency),
});
// Node 26 fetch negotiates HTTP/2; concurrent immutable uploads can hit stream
// resets. Match the deployer's bounded HTTP/1 transport for both PUT and POST.
function transport(
  url: string,
  method: string,
  body: Uint8Array | string,
  headers: Record<string, string>,
) {
  return new Promise<{ status: number; text: string }>((yes, no) => {
    const request = httpsRequest(
      url,
      {
        method,
        agent,
        headers: {
          ...headers,
          "content-length": String(
            typeof body === "string" ? Buffer.byteLength(body) : body.length,
          ),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (b) => {
          bytes += b.length;
          if (bytes > 1048576) {
            response.destroy(Error("Oversized publication acknowledgment"));
            return;
          }
          chunks.push(b);
        });
        response.once("error", no);
        response.once("end", () =>
          yes({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    request.setTimeout(180000, () =>
      request.destroy(Error("Publication timeout")),
    );
    request.once("error", no);
    request.end(body);
  });
}
type Head = { status: number; headers: Record<string, string> };
async function post(
  url: string,
  token: string,
  body: Uint8Array | string,
  extra: Record<string, string> = {},
) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await transport(url, "POST", body, {
          authorization: `Bearer ${token}`,
          ...extra,
        }),
        text = r.text;
      if (r.status < 200 || r.status >= 300)
        throw Error("Publication HTTP " + r.status + ": " + text.slice(0, 500));
      return JSON.parse(text);
    } catch (error) {
      if (attempt === 7) throw error;
      await new Promise((r) =>
        setTimeout(r, Math.min(10000, 500 * 2 ** attempt)),
      );
    }
  }
}
export async function inspectObjects(
  url: string,
  token: string,
  keys: string[],
) {
  const found = new Map<string, Head>();
  let next = 0,
    completed = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (;;) {
        const at = next;
        next += 256;
        const batch = keys.slice(at, at + 256);
        if (!batch.length) return;
        const rows = await post(
          url + "/__head-batch",
          token,
          JSON.stringify(batch),
        );
        if (
          !Array.isArray(rows) ||
          rows.length !== batch.length ||
          rows.some((r, i) => r.key !== batch[i])
        )
          throw Error("Invalid inspection response");
        for (const row of rows) found.set(row.key, row);
        completed += batch.length;
        if (completed % 4096 === 0 || completed === keys.length)
          console.log(
            "Inspected immutable objects",
            completed,
            "/",
            keys.length,
          );
      }
    }),
  );
  return found;
}
export async function publishAuxiliary(
  url: string,
  token: string,
  objects: AuxiliaryObject[],
  receipt: string,
) {
  await mkdir(dirname(receipt), { recursive: true });
  // Resume only acknowledged batches from this exact inventory. Revalidate all
  // acknowledged identities in R2 before trusting the local progress journal.
  const inventory = createHash("sha256")
    .update(JSON.stringify(objects))
    .digest("hex");
  const previous = (await readFile(receipt, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.inventory === inventory);
  const acknowledged = new Set<string>(previous.flatMap((r) => r.keys));
  if (acknowledged.size) {
    const identities = new Map<string, PublicationRecord>(
      previous.flatMap((r) =>
        r.records.map((record: PublicationRecord) => [record.key, record]),
      ),
    );
    const existing = await inspectObjects(url, token, [...acknowledged]);
    for (const [key, h] of existing) {
      const identity = identities.get(key)!;
      if (h.status === 404) acknowledged.delete(key);
      else if (
        h.status !== 200 ||
        Number(h.headers["content-length"]) !== identity.size ||
        h.headers["x-sha256"] !== identity.sha256
      )
        throw Error("Acknowledged immutable identity mismatch: " + key);
    }
  }
  const pending = objects.filter((o) => !acknowledged.has(o.key));
  const large = pending.filter((o) => o.size + 65540 > MAX_PUBLICATION_BYTES);
  const batches: AuxiliaryObject[][] = [];
  let batch: AuxiliaryObject[] = [],
    bytes = 0;
  for (const item of pending.filter((o) => !large.includes(o))) {
    if (
      batch.length &&
      (batch.length === 128 || bytes + item.size > 4 * 1048576)
    ) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(item);
    bytes += item.size;
  }
  if (batch.length) batches.push(batch);
  let next = 0,
    done = acknowledged.size,
    transferred = 0;
  const started = performance.now();
  console.log(
    "Publishing auxiliary objects",
    pending.length,
    "of",
    objects.length,
    "in",
    batches.length,
    "bounded batches",
  );
  let largeNext = 0;
  await Promise.all(
    Array.from({ length: largeConcurrency }, async () => {
      for (;;) {
        const item = large[largeNext++];
        if (!item) return;
        if (item.size > 64 * 1048576)
          throw Error("Object exceeds streaming publication: " + item.key);
        const raw = await readFile(item.path);
        if (raw.length !== item.size) throw Error("Publication size mismatch");
        const record: PublicationRecord = {
            key: item.key,
            size: item.size,
            sha256: createHash("sha256").update(raw).digest("hex"),
            packageFirst: item.packageFirst,
            packageEnd: item.packageEnd,
          },
          body = await compress(raw, { level: 6 });
        if (item.sha256 && item.sha256 !== record.sha256)
          throw Error("Auxiliary manifest hash mismatch: " + item.key);
        for (let attempt = 0; ; attempt++) {
          try {
            const response = await transport(
              url + "/" + item.key,
              "PUT",
              body,
              {
                authorization: `Bearer ${token}`,
                "x-sha256": record.sha256,
                "x-raw-length": String(item.size),
                ...(item.packageFirst === undefined
                  ? {}
                  : {
                      "x-package-first": String(item.packageFirst),
                      "x-package-end": String(item.packageEnd),
                    }),
              },
            );
            if (response.status < 200 || response.status >= 300)
              throw Error(
                "Publication HTTP " +
                  response.status +
                  ": " +
                  response.text.slice(0, 300),
              );
            break;
          } catch (error) {
            if (attempt === 7) throw error;
            await new Promise((r) =>
              setTimeout(r, Math.min(10000, 500 * 2 ** attempt)),
            );
          }
        }
        const h = (await inspectObjects(url, token, [item.key])).get(item.key)!;
        if (
          h.status !== 200 ||
          Number(h.headers["content-length"]) !== item.size ||
          h.headers["x-sha256"] !== record.sha256
        )
          throw Error("Unverified large publication");
        await appendFile(
          receipt,
          JSON.stringify({
            inventory,
            at: new Date().toISOString(),
            keys: [item.key],
            records: [record],
            result: { objects: 1 },
          }) + "\n",
        );
        done++;
        transferred += body.length;
        console.log(
          "Published large object",
          largeNext,
          "/",
          large.length,
          item.key,
        );
      }
    }),
  );
  await Promise.all(
    Array.from({ length: 12 }, async () => {
      for (;;) {
        const items = batches[next++];
        if (!items) return;
        const buffers = await Promise.all(items.map((o) => readFile(o.path)));
        const records: PublicationRecord[] = items.map((o, i) => {
          if (buffers[i].length !== o.size)
            throw Error("Auxiliary size mismatch: " + o.key);
          if (
            o.sha256 &&
            createHash("sha256").update(buffers[i]).digest("hex") !== o.sha256
          )
            throw Error("Auxiliary manifest hash mismatch: " + o.key);
          return {
            key: o.key,
            size: o.size,
            sha256: createHash("sha256").update(buffers[i]).digest("hex"),
            packageFirst: o.packageFirst,
            packageEnd: o.packageEnd,
          };
        });
        const manifest = Buffer.from(JSON.stringify(records));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(manifest.length);
        const raw = Buffer.concat([header, manifest, ...buffers]);
        const compressed = await compress(raw, { level: 6 });
        const result = await post(url + "/__publish-batch", token, compressed, {
          "x-raw-length": String(raw.length),
        });
        if (
          result.objects !== items.length ||
          result.stored + result.existing !== items.length
        )
          throw Error("Incomplete publication acknowledgment");
        await appendFile(
          receipt,
          JSON.stringify({
            inventory,
            at: new Date().toISOString(),
            keys: items.map((o) => o.key),
            records,
            result,
          }) + "\n",
        );
        done += items.length;
        transferred += compressed.length;
        if (next % 25 === 0 || done === objects.length)
          console.log(
            "Published auxiliary objects",
            done,
            "/",
            objects.length,
            "wire MiB",
            Math.round(transferred / 1048576),
            "elapsed s",
            Math.round((performance.now() - started) / 1000),
          );
      }
    }),
  );
}
