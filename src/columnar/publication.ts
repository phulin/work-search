// Bounded deployment transport. This module is never bundled into search Workers.
export const publicationKey =
  /^[a-f0-9]{64}\/(?:plan-\d+|stage-[a-f0-9]{64}|pairs-\d+|positions-\d+|presence-\d+|metadata)\.bin$/;
export const MAX_PUBLICATION_BYTES = 8 * 1048576;
export type PublicationRecord = {
  key: string;
  size: number;
  sha256: string;
  packageFirst?: number;
  packageEnd?: number;
};

export async function inspectPublication(bucket: R2Bucket, keys: unknown) {
  if (
    !Array.isArray(keys) ||
    !keys.length ||
    keys.length > 256 ||
    keys.some((k) => typeof k !== "string" || !publicationKey.test(k)) ||
    new Set(keys).size !== keys.length
  )
    throw Error("Invalid inspection batch");
  let next = 0;
  const rows = new Array(keys.length);
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (;;) {
        const i = next++;
        if (i >= keys.length) return;
        const object = await bucket.head(keys[i]);
        rows[i] = {
          key: keys[i],
          status: object ? 200 : 404,
          headers: object
            ? {
                "content-length": String(object.size),
                "x-sha256": object.customMetadata?.sha256 ?? "",
                "x-generation": object.customMetadata?.generation ?? "",
                "x-package-first": object.customMetadata?.packageFirst ?? "",
                "x-package-end": object.customMetadata?.packageEnd ?? "",
              }
            : {},
        };
      }
    }),
  );
  return rows;
}

export async function publicationBody(request: Request) {
  const size = Number(request.headers.get("x-raw-length"));
  if (
    !Number.isSafeInteger(size) ||
    size < 5 ||
    size > MAX_PUBLICATION_BYTES ||
    !request.body
  )
    throw Error("Invalid publication body size");
  const data = new Uint8Array(size);
  const reader = (
    request.headers.get("x-transport") === "raw"
      ? request.body
      : request.body.pipeThrough(new DecompressionStream("gzip"))
  ).getReader();
  let at = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (at + value.length > size)
        throw Error("Publication exceeds declared length");
      data.set(value, at);
      at += value.length;
    }
  } finally {
    await reader.cancel();
  }
  if (at !== size) throw Error("Truncated publication");
  return data;
}

export async function publishBatch(bucket: R2Bucket, data: Uint8Array) {
  const start = performance.now();
  if (data.length < 5 || data.length > MAX_PUBLICATION_BYTES)
    throw Error("Invalid publication length");
  const length = new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  ).getUint32(0, true);
  if (length > 65536 || length + 4 > data.length)
    throw Error("Invalid publication manifest");
  const records: PublicationRecord[] = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      data.subarray(4, 4 + length),
    ),
  );
  if (
    !Array.isArray(records) ||
    !records.length ||
    records.length > 128 ||
    records.some(
      (r) =>
        !r ||
        typeof r.key !== "string" ||
        !publicationKey.test(r.key) ||
        !Number.isSafeInteger(r.size) ||
        r.size < 1 ||
        !/^[a-f0-9]{64}$/.test(r.sha256) ||
        ((r.packageFirst !== undefined || r.packageEnd !== undefined) &&
          (!Number.isSafeInteger(r.packageFirst) ||
            !Number.isSafeInteger(r.packageEnd) ||
            r.packageFirst! < 0 ||
            r.packageEnd! <= r.packageFirst! ||
            !r.key.endsWith("/plan-0.bin") ||
            r.key.split("/")[0] !== r.sha256)) ||
        (r.key.endsWith("/metadata.bin") && r.key.split("/")[0] !== r.sha256),
    ) ||
    new Set(records.map((r) => r.key)).size !== records.length
  )
    throw Error("Invalid publication records");
  const offsets = [4 + length];
  for (const r of records) offsets.push(offsets.at(-1)! + r.size);
  if (offsets.at(-1) !== data.length)
    throw Error("Publication payload size mismatch");
  let next = 0,
    stored = 0,
    existing = 0;
  const writes = await Promise.allSettled(
    Array.from({ length: 6 }, async () => {
      for (;;) {
        const i = next++;
        if (i >= records.length) return;
        const r = records[i],
          generation = r.key.split("/")[0];
        // Atomic create, including R2's checksum verification. A retry never
        // overwrites an existing immutable object, including after partial success.
        const object = await bucket.put(
          r.key,
          data.subarray(offsets[i], offsets[i + 1]),
          {
            sha256: r.sha256,
            onlyIf: new Headers({ "If-None-Match": "*" }),
            customMetadata: {
              generation,
              sha256: r.sha256,
              ...(r.packageFirst === undefined
                ? {}
                : {
                    packageFirst: String(r.packageFirst),
                    packageEnd: String(r.packageEnd),
                  }),
            },
          },
        );
        if (object) stored++;
        else {
          const old = await bucket.head(r.key);
          if (
            !old ||
            old.size !== r.size ||
            old.customMetadata?.sha256 !== r.sha256 ||
            old.customMetadata?.generation !== generation ||
            (r.packageFirst !== undefined &&
              (old.customMetadata.packageFirst !== String(r.packageFirst) ||
                old.customMetadata.packageEnd !== String(r.packageEnd)))
          )
            throw Error("Immutable conflict: " + r.key);
          existing++;
        }
      }
    }),
  );
  // Retain the batch's memory reservation until every in-flight R2 call ends,
  // including when one of the parallel writes fails and the client will retry.
  for (const write of writes)
    if (write.status === "rejected") throw write.reason;
  return {
    wallMs: performance.now() - start,
    stored,
    existing,
    objects: records.length,
    bytes: records.reduce((n, r) => n + r.size, 0),
  };
}
