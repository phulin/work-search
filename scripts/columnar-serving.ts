import {
  readFile,
  writeFile,
  mkdir,
  cp,
  stat,
  rm,
  readdir,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { ColumnarIndex } from "../src/columnar/search.js";
import { TermDirectory } from "../src/columnar/term-directory.js";
import { DocumentDirectory } from "../src/columnar/document-directory.js";
import { PairRouter } from "../src/columnar/pair-router.js";
import {
  MetadataIndex,
  type MetadataManifest,
} from "../src/columnar/metadata-filter.js";
import type { MembershipSettings } from "../src/columnar/membership-anchor.js";
import type { Root } from "../src/columnar/format.js";
import type { Source } from "../src/columnar/storage.js";
export type AuxiliaryObject = { key: string; size: number; path: string };
export type ServingOptions = {
  membershipDir?: string;
  metadataDir?: string;
  N?: number;
  M?: number;
};
export function servingOptions(args = process.argv): ServingOptions {
  const option = (key: string, env: string) => {
    const at = args.indexOf(key);
    if (at >= 0 && (!args[at + 1] || args[at + 1].startsWith("--")))
      throw Error("Missing " + key + " argument");
    return at >= 0 ? resolve(args[at + 1]) : process.env[env];
  };
  return {
    membershipDir: option("--membership", "CWS_MEMBERSHIP_DIR"),
    metadataDir: option("--metadata", "CWS_METADATA_DIR"),
    N: Number(process.env.CWS_COMMON_WORDS ?? 100),
    M: Number(process.env.CWS_COMMON_PAIRS ?? 1000),
  };
}
export async function loadServingAssets(
  indexDir: string,
  options: ServingOptions = {},
) {
  const root: Root = JSON.parse(
      await readFile(join(indexDir, "root.json"), "utf8"),
    ),
    auxiliary: AuxiliaryObject[] = [];
  async function binary(
    name: string,
    descriptor: { bytes: number; sha256: string } | undefined,
  ) {
    if (!descriptor) return;
    const bytes = await readFile(join(indexDir, name));
    if (
      bytes.length !== descriptor.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256
    )
      throw Error("Bundled identity mismatch: " + name);
    return bytes;
  }
  const directory = await binary("directory.bin", root.directory),
    documents = await binary("documents.bin", root.documentPackages?.locators);
  let membership: MembershipSettings | undefined,
    router: Uint8Array | undefined,
    metadata: MetadataManifest | undefined;
  const membershipDir = options.membershipDir ?? join(indexDir, "membership"),
    metadataDir = options.metadataDir ?? join(indexDir, "metadata");
  const exists = async (path: string) =>
    stat(path).then(
      () => true,
      (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return false;
        throw e;
      },
    );
  if (
    options.membershipDir ||
    (await exists(join(membershipDir, "router.bin")))
  ) {
    router = await readFile(join(membershipDir, "router.bin"));
    const routing = new PairRouter(router),
      presence = JSON.parse(
        await readFile(join(membershipDir, "presence.json"), "utf8"),
      );
    if (
      presence.generation !== routing.metadata.generation ||
      presence.entries.length <
        Math.min(200, routing.metadata.commonWords.length)
    )
      throw Error("Presence generation/coverage mismatch");
    membership = {
      router: routing,
      presence,
      N: options.N ?? 100,
      M: options.M ?? 1000,
    };
    for (const o of routing.objects())
      auxiliary.push({
        key: o.key,
        size: o.bytes,
        path: join(membershipDir, "objects", o.key.split("/")[1]),
      });
    presence.entries.forEach((p: { bytes: number }, i: number) =>
      auxiliary.push({
        key: routing.metadata.generation + `/presence-${i}.bin`,
        size: p.bytes,
        path: join(membershipDir, "presence", i + ".bin"),
      }),
    );
  }
  if (
    options.metadataDir ||
    (await exists(join(metadataDir, "metadata.json")))
  ) {
    metadata = JSON.parse(
      await readFile(join(metadataDir, "metadata.json"), "utf8"),
    );
    new MetadataIndex(metadata!, root);
    const { generation, ...identity } = metadata!;
    if (
      createHash("sha256").update(JSON.stringify(identity)).digest("hex") !==
      generation
    )
      throw Error("Metadata manifest identity mismatch");
    const seen = new Set<string>();
    for (const b of metadata!.blocks)
      for (const c of Object.values(b.columns))
        if (!seen.has(c.key)) {
          seen.add(c.key);
          auxiliary.push({
            key: c.key,
            size: c.bytes,
            path: join(metadataDir, "objects", c.key.split("/")[0] + ".bin"),
          });
        }
  }
  new ColumnarIndex(
    root,
    undefined,
    directory ? new TermDirectory(directory, root.count) : undefined,
    undefined,
    documents ? new DocumentDirectory(documents) : undefined,
    membership,
  );
  return {
    root,
    directory,
    documents,
    membership,
    router,
    metadata,
    auxiliary,
  };
}
export type ServingAssets = Awaited<ReturnType<typeof loadServingAssets>>;
export function matchesServingHealth(a: ServingAssets, health: any) {
  return (
    health?.format === "CWS1" &&
    health.generation === a.root.generation &&
    health.documents === a.root.count &&
    health.analysis === a.root.analysis &&
    health.metadataGeneration === a.metadata?.generation &&
    health.pairGeneration === a.membership?.router.metadata.generation &&
    (!a.membership ||
      (health.commonWordAnchorsExcluded === a.membership.N &&
        health.commonPairAnchorsExcluded === a.membership.M))
  );
}
export async function verifyDocumentPublication(
  documents: Uint8Array | undefined,
  head: (key: string) => Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
  }>,
  concurrency = 8,
) {
  if (!documents) return;
  const groups = [...new DocumentDirectory(documents).groups()];
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const group = groups[next++];
        if (!group) return;
        const h = await head(group.key);
        if (
          h.status !== 200 ||
          Number(h.headers["content-length"]) !== group.bytes ||
          h.headers["x-sha256"] !== group.key.split("/")[0] ||
          Number(h.headers["x-package-first"]) !== group.first ||
          Number(h.headers["x-package-end"]) !== group.end
        )
          throw Error("Unpublished document group: " + group.key);
      }
    }),
  );
}
export function localServingSource(
  source: Source,
  assets: ServingAssets,
): Source {
  const objects = new Map(assets.auxiliary.map((o) => [o.key, o]));
  return {
    read: source.read.bind(source),
    readPage: source.readPage?.bind(source),
    readWhole: source.readWhole?.bind(source),
    readNamed: async (key, bytes) => {
      const o = objects.get(key);
      if (!o || o.size !== bytes)
        throw Error("Unknown local serving object: " + key);
      const data = await readFile(o.path);
      if (data.length !== bytes) throw Error("Truncated local serving object");
      return data;
    },
  };
}
export function servingRoot(root: Root): Root {
  return {
    ...root,
    objects: root.objects.map(({ checksums: _obsolete, ...object }) => object),
  };
}
export function servingImports(a: ServingAssets, dir: string) {
  return `${a.router ? `import routerData from ${JSON.stringify(join(dir, "router.bin"))};import presence from ${JSON.stringify(join(dir, "presence.json"))};import{PairRouter}from ${JSON.stringify(join(dir, "src/columnar/pair-router.ts"))};` : ""}${a.metadata ? `import metadataManifest from ${JSON.stringify(join(dir, "metadata.json"))};` : ""}`;
}
export function servingArguments(a: ServingAssets) {
  return `undefined,${a.membership ? `{router:new PairRouter(new Uint8Array(routerData)),presence,N:${a.membership.N},M:${a.membership.M}}` : "undefined"},${a.metadata ? "metadataManifest as any" : "undefined"}`;
}
export async function copyServingExtras(a: ServingAssets, dir: string) {
  if (a.router) {
    await writeFile(join(dir, "router.bin"), a.router);
    await writeFile(
      join(dir, "presence.json"),
      JSON.stringify(a.membership!.presence),
    );
  }
  if (a.metadata)
    await writeFile(join(dir, "metadata.json"), JSON.stringify(a.metadata));
}
/** Entirely local: no token lookup, remote HEAD, upload, or deployment. */
export async function prepareServing(
  indexDir: string,
  out: string,
  name: string,
  options: ServingOptions = {},
) {
  if (!/^[a-z0-9-]{1,48}$/.test(name)) throw Error("Invalid Worker name");
  const a = await loadServingAssets(indexDir, options);
  if (!a.directory || !a.documents)
    throw Error("Replacement serving requires term and document directories");
  let next = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      for (;;) {
        const object = a.auxiliary[next++];
        if (!object) return;
        if ((await stat(object.path)).size !== object.size)
          throw Error("Local auxiliary size mismatch: " + object.key);
        if (
          object.key.endsWith("/metadata.bin") &&
          createHash("sha256")
            .update(await readFile(object.path))
            .digest("hex") !== object.key.split("/")[0]
        )
          throw Error("Local metadata digest mismatch: " + object.key);
      }
    }),
  );
  await mkdir(out, { recursive: true });
  for (const dir of ["columnar", "query", "format", "storage"])
    await cp(resolve("src", dir), join(out, "src", dir), { recursive: true });
  const bundledRoot = servingRoot(a.root);
  await writeFile(join(out, "root.json"), JSON.stringify(bundledRoot));
  await writeFile(join(out, "directory.bin"), a.directory);
  await writeFile(join(out, "documents.bin"), a.documents);
  await copyServingExtras(a, out);
  await writeFile(
    join(out, "entry.ts"),
    `import root from './root.json';import directory from './directory.bin';import documents from './documents.bin';import{createColumnarWorker}from './src/columnar/worker.ts';${servingImports(a, out)}export default createColumnarWorker(root as any,undefined,undefined,new Uint8Array(directory),new Uint8Array(documents),${servingArguments(a)});`,
  );
  await writeFile(
    join(out, "wrangler.json"),
    JSON.stringify(
      {
        name,
        main: "./entry.ts",
        compatibility_date: "2026-11-01",
        rules: [{ type: "Data", globs: ["**/*.bin"], fallthrough: true }],
        r2_buckets: [
          {
            binding: "INDEX",
            bucket_name: process.env.CWS_BUCKET ?? "work-search-demo",
          },
        ],
        limits: { cpu_ms: 300000 },
        vars: { CACHE_NAMESPACE: name, PAGE_CACHE: "1" },
        version_metadata: { binding: "CF_VERSION_METADATA" },
        observability: { enabled: true },
      },
      null,
      2,
    ),
  );
  const bundleDataBytes =
    Buffer.byteLength(JSON.stringify(bundledRoot)) +
    a.directory.length +
    a.documents.length +
    (a.router?.length ?? 0) +
    Buffer.byteLength(JSON.stringify(a.metadata ?? {})) +
    Buffer.byteLength(JSON.stringify(a.membership?.presence ?? {}));
  if (bundleDataBytes >= 64 * 1048576)
    throw Error(
      "Serving data exceeds the 64 MiB Worker limit; reduce bundled directory/router data before deployment",
    );
  const groups = [...new DocumentDirectory(a.documents).groups()];
  const report = {
    engine: "columnar",
    documents: a.root.count,
    generation: a.root.generation,
    analysis: a.root.analysis,
    bundleDataBytes,
    metadataGeneration: a.metadata?.generation,
    metadataFields: Object.keys(a.metadata?.schema ?? {}),
    pairGeneration: a.membership?.router.metadata.generation,
    commonWords: a.membership?.N,
    commonPairs: a.membership?.M,
    auxiliaryObjects: a.auxiliary.length,
    auxiliaryBytes: a.auxiliary.reduce((n, o) => n + o.size, 0),
    auxiliaryLocalSizesVerified: true,
    documentGroups: groups.length,
    documentPackageBytes: groups.reduce((n, g) => n + g.bytes, 0),
    publicationObjects: a.root.objects.length,
    requiresRemotePublicationVerification: true,
  };
  await writeFile(join(out, "preflight.json"), JSON.stringify(report, null, 2));
  // Keep publication inventory separate from the compact human-facing report.
  await writeFile(
    join(out, "auxiliary-objects.json"),
    JSON.stringify(a.auxiliary),
  );
  return report;
}
export async function bundleServing(out: string) {
  const dist = join(out, "dist");
  await rm(dist, { recursive: true, force: true });
  await new Promise<void>((ok, no) => {
    const child = spawn(
      "yarn",
      [
        "wrangler",
        "deploy",
        "--config",
        join(out, "wrangler.json"),
        "--dry-run",
        "--outdir",
        dist,
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_LOG_PATH:
            process.env.WRANGLER_LOG_PATH ?? join(out, "wrangler.log"),
        },
      },
    );
    child.once("error", no);
    child.once("exit", (code) =>
      code === 0 ? ok() : no(Error("Bundle failed " + code)),
    );
  });
  async function moduleBytes(dir: string): Promise<number> {
    let n = 0;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) n += await moduleBytes(p);
      else if (/\.(?:js|mjs|bin|wasm)$/.test(e.name)) n += (await stat(p)).size;
    }
    return n;
  }
  const bundleModuleBytes = await moduleBytes(dist);
  if (bundleModuleBytes > 64 * 1048576)
    throw Error("Compiled Worker exceeds the 64 MiB module limit");
  const report = JSON.parse(
    await readFile(join(out, "preflight.json"), "utf8"),
  );
  await writeFile(
    join(out, "preflight.json"),
    JSON.stringify({ ...report, bundleModuleBytes }, null, 2),
  );
  return bundleModuleBytes;
}
