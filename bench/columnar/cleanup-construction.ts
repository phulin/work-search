import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { DocumentDirectory } from "../../src/columnar/document-directory.js";

// Produce an exact allowlist. Never infer that every content-addressed object in
// the bucket is disposable: different indexes can share the same bytes.
const [out, ...builds] = process.argv.slice(2);
if (!out || !builds.length)
  throw Error("Use OUTPUT_DIRECTORY BUILD_DIRECTORY...");
await mkdir(out, { recursive: true });
const candidates = new Map<string, number>(),
  keep = new Set<string>(),
  receiptKeys = new Set<string>(),
  rootFiles: string[] = [];
function refs(value: any, visit: (key: string, bytes: number) => void) {
  if (!value || typeof value !== "object") return;
  if (typeof value.key === "string")
    visit(value.key, value.objectBytes ?? value.size ?? value.bytes ?? 0);
  if (typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256))
    visit(value.sha256 + "/plan-0.bin", value.size ?? value.bytes ?? 0);
  for (const child of Object.values(value)) refs(child, visit);
}
const exec = promisify(execFile);
const files = (
  await exec(
    "rg",
    [
      "--files",
      "--hidden",
      "work",
      "-g",
      "*root.json",
      "-g",
      "!**/tasks/**",
      "-g",
      "!**/node_modules/**",
      "-g",
      "!**/source/src/**",
      "-g",
      "!**/oracle.json.native-parts/**",
    ],
    { maxBuffer: 16 * 1048576 },
  )
).stdout
  .trim()
  .split("\n");
for (const file of files) {
  const root = JSON.parse(await readFile(file, "utf8"));
  rootFiles.push(file);
  refs(root, (key) => keep.add(key));
  for (const o of root.objects ?? [])
    keep.add(o.key ?? root.generation + "/" + o.name);
  if (root.documentPackages?.locators) {
    const dir = file.slice(0, file.lastIndexOf("/")),
      bytes = await readFile(dir + "/documents.bin");
    try {
      if (bytes.readUInt32LE(0) === 0x31444443) {
        const groups = bytes.readUInt32LE(8);
        if (
          16 + groups * 48 !== bytes.readUInt32LE(12) ||
          16 + groups * 48 > bytes.length
        )
          throw Error("Invalid historical document directory");
        for (let i = 0; i < groups; i++)
          keep.add(
            bytes.subarray(32 + i * 48, 64 + i * 48).toString("hex") +
              "/plan-0.bin",
          );
      } else
        for (const g of new DocumentDirectory(bytes).groups()) keep.add(g.key);
    } catch (error) {
      throw Error(file + ": " + String(error));
    }
  }
}
let scannedFiles = 0;
async function scan(directory: string, build?: string) {
  const manifest = await readFile(directory + "/manifest.json", "utf8").catch(
    () => undefined,
  );
  if (manifest) build = JSON.parse(manifest).identity?.build ?? build;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = directory + "/" + entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "tasks") await scan(file, build);
      continue;
    }
    if (
      !entry.name.endsWith(".json") ||
      entry.name.startsWith("oracle") ||
      entry.name === "root.json"
    )
      continue;
    const value = JSON.parse(await readFile(file, "utf8"));
    scannedFiles++;
    refs(value, (key, n) => {
      if (/^([a-f0-9]{64})\/(?:plan-\d+|stage-[a-f0-9]{64})\.bin$/.test(key))
        candidates.set(key, Math.max(candidates.get(key) ?? 0, Number(n) || 0));
    });
    if (directory.endsWith("/tasks") && build)
      receiptKeys.add(`cws-fresh-v3/${build}/${entry.name}`);
  }
}
for (const build of builds) {
  if (!resolve(build).startsWith(resolve("work") + "/"))
    throw Error("Only local work checkpoints");
  await stat(build);
  await scan(build);
}
const selected = [...candidates]
    .filter(([k]) => !keep.has(k))
    .sort(([a], [b]) => a.localeCompare(b)),
  keys = [...selected.map(([k]) => k), ...receiptKeys].sort(),
  report = {
    at: new Date().toISOString(),
    builds,
    scannedFiles,
    rootFiles,
    protectedKeys: keep.size,
    candidates: candidates.size,
    selected: selected.length,
    receipts: receiptKeys.size,
    estimatedBytes: selected.reduce((n, [, b]) => n + b, 0),
    note: "Byte estimates can include logical slices. Actual deleted bytes require R2 metadata. Local checkpoints cease to be resumable after deletion.",
  };
if (keys.some((k) => keep.has(k))) throw Error("Protected deletion");
await writeFile(out + "/keys.json", JSON.stringify(keys));
await writeFile(out + "/protected.json", JSON.stringify([...keep].sort()));
await writeFile(out + "/plan.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, rootFiles: rootFiles.length }));
