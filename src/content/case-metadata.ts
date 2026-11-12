import { crc32 } from "../format/codec.js";

interface Manifest {
  version: number;
  generation: string;
  maxId: number;
  recordBytes: number;
}
const states = new WeakMap<R2Bucket, CaseMetadata>();
export function caseMetadata(bucket: R2Bucket) {
  let state = states.get(bucket);
  if (!state) states.set(bucket, (state = new CaseMetadata(bucket)));
  return state;
}

/** Separately versioned, immutable display data; never changes index ranking. */
export class CaseMetadata {
  private manifest?: Manifest | null;
  private checked = 0;
  private loading?: Promise<Manifest | null>;
  private cache = new Map<string, { value: any; bytes: number }>();
  private cacheBytes = 0;
  constructor(private bucket: R2Bucket) {}

  private async current() {
    if (Date.now() - this.checked < 30000) return this.manifest ?? null;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const object = await this.bucket.get("demo-case-metadata.json");
      const m = object ? ((await object.json()) as Manifest) : null;
      if (
        m &&
        (![1, 2].includes(m.version) ||
          m.recordBytes !== 16 ||
          !/^[a-f0-9]{64}$/.test(m.generation) ||
          !Number.isSafeInteger(m.maxId))
      )
        throw Error("Incompatible case metadata");
      if (m?.generation !== this.manifest?.generation) {
        this.cache.clear();
        this.cacheBytes = 0;
      }
      this.manifest = m;
      this.checked = Date.now();
      return m;
    })();
    try {
      return await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  async get(id: number) {
    if (!Number.isSafeInteger(id) || id < 0) return null;
    const m = await this.current();
    if (!m || id > m.maxId) return null;
    const cacheKey = `${m.generation}:${id}`;
    const hit = this.cache.get(cacheKey);
    if (hit) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, hit);
      return hit.value;
    }
    const recordsPerObject = 4194304;
    const map = await this.bucket.get(
      `${m.generation}/casemap-${Math.floor(id / recordsPerObject)}.bin`,
      {
        range: { offset: (id % recordsPerObject) * 16, length: 16 },
      },
    );
    if (!map || map.customMetadata?.generation !== m.generation)
      throw Error("Case catalog generation mismatch");
    const bytes = await map.arrayBuffer();
    if (bytes.byteLength !== 16) throw Error("Truncated case catalog");
    const v = new DataView(bytes),
      length = v.getUint32(8, true);
    if (!length) return null;
    if (length > 1048576) throw Error("Invalid case metadata length");
    const record = await this.bucket.get(
      `${m.generation}/cases-${v.getUint32(0, true)}.bin`,
      {
        range: { offset: v.getUint32(4, true), length },
      },
    );
    if (!record || record.customMetadata?.generation !== m.generation)
      throw Error("Case record generation mismatch");
    const b = new Uint8Array(await record.arrayBuffer());
    if (b.length !== length || crc32(b) !== v.getUint32(12, true))
      throw Error("Case metadata checksum mismatch");
    let value: any;
    if (m.version === 2) {
      const stream = new Response(b).body!.pipeThrough(
        new DecompressionStream("gzip"),
      );
      const reader = stream.getReader(),
        decoder = new TextDecoder();
      let text = "",
        size = 0;
      try {
        for (;;) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          size += chunk.length;
          if (size > 1048576)
            throw Error("Case metadata block exceeds decoder limit");
          text += decoder.decode(chunk, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel().catch(() => {});
      }
      const block = JSON.parse(text);
      if (!Array.isArray(block) || block.length > 256)
        throw Error("Invalid case metadata block");
      value = block.find((record: any) => record.cluster_id === id);
    } else value = JSON.parse(new TextDecoder().decode(b));
    if (value?.cluster_id !== id) throw Error("Case identity mismatch");
    // Charge decoded strings/objects conservatively, not only encoded bytes.
    const charge = JSON.stringify(value).length * 4 + 512;
    if (charge <= 4 * 1048576 && this.manifest?.generation === m.generation) {
      const old = this.cache.get(cacheKey);
      if (old) this.cacheBytes -= old.bytes;
      this.cache.set(cacheKey, { value, bytes: charge });
      this.cacheBytes += charge;
      while (this.cache.size > 512 || this.cacheBytes > 4 * 1048576) {
        const key = this.cache.keys().next().value!;
        this.cacheBytes -= this.cache.get(key)!.bytes;
        this.cache.delete(key);
      }
    }
    return value;
  }

  async enrich(info: any) {
    const detail = await this.get(Number(info.metadata?.cluster_id));
    const title = displayCaption(
      detail?.title,
      detail?.case_name_full,
      info.title,
    );
    return {
      ...info,
      title,
      metadata: {
        ...info.metadata,
        ...(detail ?? {}),
        caption_available: !!title,
      },
    };
  }
}

export function displayCaption(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const s = value.trim();
    if (
      s &&
      !["\\N", "N", "null", "None"].includes(s) &&
      !/^Opinion \d+$/.test(s) &&
      !s.startsWith("courtlistener-opinion:")
    )
      return s;
  }
  return "";
}
