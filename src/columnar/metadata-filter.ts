import { packageBatches } from "./package-batches.js";
import type { DocumentFilter } from "./document-filter.js";
import type { Root } from "./format.js";
import { concat, u32, view, lower } from "./format.js";
import { Semaphore, type Reader } from "./storage.js";
import { QuerySyntaxError } from "../query/parser.js";

export type MetadataScalar = string | number | boolean;
export type MetadataSchema = Record<string, "string" | "number" | "boolean">;
export type MetadataPredicate =
  | { and: MetadataPredicate[] }
  | { or: MetadataPredicate[] }
  | { not: MetadataPredicate }
  | { field: string; op: "exists" }
  | { field: string; op: "in"; value: MetadataScalar[] }
  | {
      field: string;
      op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
      value: MetadataScalar;
    };
export interface MetadataManifest {
  format: "CWM1";
  generation: string;
  baseGeneration: string;
  count: number;
  blockDocuments: number;
  schema: MetadataSchema;
  blocks: {
    first: number;
    count: number;
    columns: Record<string, { key: string; bytes: number }>;
  }[];
}
const types = { string: 1, number: 2, boolean: 3 };
export function encodeMetadataColumn(
  first: number,
  type: MetadataSchema[string],
  values: (MetadataScalar | null | undefined)[],
) {
  const header = u32([0x31434d43, first, values.length, types[type]]);
  for (const v of values)
    if (
      v != null &&
      (typeof v !== type || (typeof v === "number" && !Number.isFinite(v)))
    )
      throw Error("Metadata value does not match schema");
  if (type === "number") {
    const data = new Uint8Array(values.length * 8),
      v = view(data);
    values.forEach((x, i) =>
      v.setFloat64(i * 8, x == null ? NaN : (x as number), true),
    );
    return concat([header, data]);
  }
  if (type === "boolean")
    return concat([
      header,
      Uint8Array.from(values, (x) => (x == null ? 0 : x ? 2 : 1)),
    ]);
  const dictionary: string[] = [],
    ids = new Map<string, number>(),
    codes = new Uint32Array(values.length);
  values.forEach((x, i) => {
    if (x == null) return;
    const s = x as string;
    let id = ids.get(s);
    if (id === undefined) {
      id = dictionary.length + 1;
      ids.set(s, id);
      dictionary.push(s);
    }
    codes[i] = id;
  });
  const keys = new TextEncoder().encode(JSON.stringify(dictionary));
  return concat([header, u32([keys.length]), u32(codes), keys]);
}
function decodeColumn(
  bytes: Uint8Array,
  first: number,
  count: number,
  type: MetadataSchema[string],
) {
  const v = view(bytes);
  if (
    bytes.length < 16 ||
    v.getUint32(0, true) !== 0x31434d43 ||
    v.getUint32(4, true) !== first ||
    v.getUint32(8, true) !== count ||
    v.getUint32(12, true) !== types[type]
  )
    throw Error("Metadata column identity mismatch");
  if (type === "number") {
    if (bytes.length !== 16 + count * 8)
      throw Error("Invalid numeric metadata column");
    return (doc: number) => {
      const x = v.getFloat64(16 + (doc - first) * 8, true);
      return Number.isNaN(x) ? undefined : x;
    };
  }
  if (type === "boolean") {
    if (bytes.length !== 16 + count || bytes.subarray(16).some((x) => x > 2))
      throw Error("Invalid Boolean metadata column");
    return (doc: number) => {
      const x = bytes[16 + doc - first];
      return x ? x === 2 : undefined;
    };
  }
  if (
    bytes.length < 20 + count * 4 ||
    bytes.length !== 20 + count * 4 + v.getUint32(16, true)
  )
    throw Error("Invalid string metadata column");
  const keys: unknown = JSON.parse(
    new TextDecoder().decode(bytes.subarray(20 + count * 4)),
  );
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string"))
    throw Error("Invalid metadata dictionary");
  for (let i = 0; i < count; i++)
    if (v.getUint32(20 + i * 4, true) > keys.length)
      throw Error("Invalid metadata dictionary code");
  return (doc: number): MetadataScalar | undefined =>
    keys[v.getUint32(20 + (doc - first) * 4, true) - 1];
}
/** Validate the entire expression before any metadata or postings I/O. Missing
 * and null values are absent: every comparison (including ne) returns false.
 * Use not/exists explicitly when missing values should be included. */
export function compileMetadataPredicate(
  input: unknown,
  schema: MetadataSchema,
) {
  const fields = new Set<string>();
  let nodes = 0;
  type Get = (field: string) => MetadataScalar | undefined;
  const invalid = (): never => {
    throw new QuerySyntaxError("Invalid metadata filter");
  };
  function compile(x: any, depth: number): (get: Get) => boolean {
    if (
      ++nodes > 256 ||
      depth > 16 ||
      !x ||
      typeof x !== "object" ||
      Array.isArray(x)
    )
      return invalid();
    if (Object.hasOwn(x, "and") || Object.hasOwn(x, "or")) {
      const key = Object.hasOwn(x, "and") ? "and" : "or";
      if (Object.keys(x).length !== 1 || !Array.isArray(x[key]))
        return invalid();
      const parts = x[key].map((p: unknown) => compile(p, depth + 1)) as ((
        get: Get,
      ) => boolean)[];
      return key === "and"
        ? (get) => parts.every((p) => p(get))
        : (get) => parts.some((p) => p(get));
    }
    if (Object.hasOwn(x, "not")) {
      if (Object.keys(x).length !== 1) return invalid();
      const p = compile(x.not, depth + 1);
      return (get) => !p(get);
    }
    if (typeof x.field !== "string" || !Object.hasOwn(schema, x.field))
      return invalid();
    fields.add(x.field);
    const field = x.field,
      type = schema[field],
      op = x.op;
    if (op === "exists") {
      if (Object.keys(x).length !== 2) return invalid();
      return (get) => get(field) !== undefined;
    }
    if (Object.keys(x).length !== 3 || !Object.hasOwn(x, "value"))
      return invalid();
    const valid = (v: unknown) =>
      typeof v === type && (type !== "number" || Number.isFinite(v));
    if (op === "in") {
      if (
        !Array.isArray(x.value) ||
        x.value.length > 1024 ||
        !x.value.every(valid)
      )
        return invalid();
      const set = new Set<MetadataScalar>(x.value);
      return (get) => {
        const a = get(field);
        return a !== undefined && set.has(a);
      };
    }
    if (
      !valid(x.value) ||
      !["eq", "ne", "lt", "lte", "gt", "gte"].includes(op) ||
      (type === "boolean" && op !== "eq" && op !== "ne")
    )
      return invalid();
    const b = x.value as MetadataScalar;
    return (get) => {
      const a = get(field);
      if (a === undefined) return false;
      switch (op) {
        case "eq":
          return a === b;
        case "ne":
          return a !== b;
        case "lt":
          return a < b;
        case "lte":
          return a <= b;
        case "gt":
          return a > b;
        default:
          return a >= b;
      }
    };
  }
  return { test: compile(input, 0), fields };
}
export class MetadataIndex {
  constructor(
    readonly manifest: MetadataManifest,
    root: Pick<Root, "generation" | "count">,
  ) {
    const m = manifest;
    if (
      m.format !== "CWM1" ||
      !/^[a-f0-9]{64}$/.test(m.generation) ||
      m.baseGeneration !== root.generation ||
      m.count !== root.count ||
      !Number.isSafeInteger(m.count) ||
      m.count < 1 ||
      !Number.isSafeInteger(m.blockDocuments) ||
      m.blockDocuments < 1 ||
      m.blockDocuments > 16384 ||
      m.blocks.length !== Math.ceil(m.count / m.blockDocuments) ||
      !Object.keys(m.schema).length ||
      Object.keys(m.schema).length > 64 ||
      Object.values(m.schema).some((t) => !Object.hasOwn(types, t))
    )
      throw Error("Invalid metadata generation or schema");
    m.blocks.forEach((b, i) => {
      if (
        b.first !== i * m.blockDocuments ||
        b.count !== Math.min(m.blockDocuments, m.count - b.first) ||
        Object.keys(b.columns).length !== Object.keys(m.schema).length
      )
        throw Error("Invalid metadata coverage");
      if (
        Object.values(b.columns).reduce((n, c) => n + c.bytes, 0) >
        4 * 1048576
      )
        throw Error(
          "Metadata block exceeds 4 MiB; use fewer documents per block",
        );
      for (const field of Object.keys(m.schema)) {
        const c = b.columns[field];
        if (
          !c ||
          !/^[a-f0-9]{64}\/metadata\.bin$/.test(c.key) ||
          !Number.isSafeInteger(c.bytes) ||
          c.bytes < 16 ||
          c.bytes > 32 * 1048576
        )
          throw Error("Invalid metadata column address");
      }
    });
  }
  filter(input: unknown, reader: Reader): DocumentFilter {
    const predicate = compileMetadataPredicate(input, this.manifest.schema),
      m = this.manifest;
    const preparing = new Semaphore(2);
    return {
      prepare: (documents) =>
        preparing.run(async () => {
          for (const doc of documents) {
            if (!Number.isInteger(doc) || doc < 0 || doc >= m.count)
              throw Error("Invalid metadata document ID");
          }
          const accepted = new Uint32Array(documents.length);
          let n = 0;
          const grouped = new Map<number, number[]>();
          for (const doc of documents) {
            const i = Math.floor(doc / m.blockDocuments),
              ids = grouped.get(i) ?? [];
            ids.push(doc);
            grouped.set(i, ids);
          }
          // Bound active metadata by actual encoded bytes; never retain all touched
          // columns of a sparse, whole-corpus candidate list at once.
          for (const group of packageBatches(
            [...grouped.keys()],
            (i) =>
              Math.max(
                1,
                [...predicate.fields].reduce(
                  (n, f) => n + m.blocks[i].columns[f].bytes,
                  0,
                ),
              ),
            4 * 1048576,
            6,
          )) {
            const beforeIO = reader.stats.requests + reader.stats.sharedGets;
            await Promise.all(
              group.items.map(async (i) => {
                const b = m.blocks[i],
                  columns = new Map<string, ReturnType<typeof decodeColumn>>();
                await Promise.all(
                  [...predicate.fields].map(async (field) => {
                    const c = b.columns[field],
                      bytes = await reader.named(c.key, c.bytes);
                    reader.stats.metadataFilterBlocks++;
                    reader.stats.metadataFilterBytes += bytes.length;
                    columns.set(
                      field,
                      decodeColumn(bytes, b.first, b.count, m.schema[field]),
                    );
                  }),
                );
                for (const doc of grouped.get(i)!)
                  if (predicate.test((field) => columns.get(field)!(doc)))
                    accepted[n++] = doc;
                columns.clear();
              }),
            );
            if (reader.stats.requests + reader.stats.sharedGets > beforeIO)
              reader.stats.metadataFilterIOWaves++;
          }
          const selected = accepted.subarray(0, n).sort();
          return (doc) => selected[lower(selected, doc)] === doc;
        }),
    };
  }
}
