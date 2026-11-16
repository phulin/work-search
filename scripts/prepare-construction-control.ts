import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  symlink,
} from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { benchmarkToken } from "../bench/columnar/token.js";

const [out, archivePath] = process.argv.slice(2);
if (!out || !archivePath)
  throw Error(
    "Usage: prepare-construction-control.ts EMPTY_OUTPUT_DIRECTORY CONTROL_ARCHIVE.tar.gz",
  );
const archive = gunzipSync(await readFile(archivePath));
const archiveSha256 = createHash("sha256").update(archive).digest("hex");
if (
  archiveSha256 !==
  "71a29105af89bbfa058c0666093707e71f40d48ad62230bf61bdd2de60b849c4"
)
  throw Error("Construction control archive changed");
await mkdir(out); // Refuse to overwrite an existing control.
await new Promise<void>((ok, no) => {
  const child = spawn("tar", ["-xf", "-", "-C", resolve(out)], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.stdin.end(archive);
  child.once("error", no);
  child.once("exit", (code) =>
    code === 0 ? ok() : no(Error("Archive extraction " + code)),
  );
});
await symlink(resolve("node_modules"), out + "/node_modules", "dir");
await mkdir(out + "/bench/columnar", { recursive: true });
await copyFile("bench/columnar/token.ts", out + "/bench/columnar/token.ts");
await mkdir(out + "/work/columnar-deploy", { recursive: true });
await writeFile(
  out + "/work/columnar-deploy/benchmark-token",
  await benchmarkToken(),
  { mode: 0o600 },
);
await copyFile(
  "src/columnar/construction/bucket.ts",
  out + "/src/columnar/construction/bucket.ts",
);
async function edit(path: string, change: (s: string) => string) {
  const full = out + "/" + path;
  await writeFile(full, change(await readFile(full, "utf8")));
}
for (const name of ["worker", "document-groups"])
  await edit("src/columnar/construction/" + name + ".ts", (s) =>
    s.replaceAll(
      "r2: counted.operations,",
      "r2: counted.operations, io: counted.snapshot(),",
    ),
  );
await edit("src/columnar/construction/pair-jobs.ts", (s) =>
  s.replaceAll("g.end - g.first > 128", "g.end - g.first > 1024"),
);
await edit("scripts/build-in-workers.ts", (s) =>
  s.replace(
    "value: await vocabularyRoot(out, root, route.idRouting, token),\n  });\n  await save();",
    "value: await vocabularyRoot(out, root, route.idRouting, token),\n  });\n  await save(true);",
  ),
);
await edit("src/columnar/construction/worker.ts", (s) =>
  s.replace(
    "bytes !== input.root.documentPackages.bytes",
    "bytes !== (input.root.documentPackages.storedBytes ?? input.root.documentPackages.bytes)",
  ),
);
await writeFile(
  out + "/control-adjustments.json",
  JSON.stringify(
    {
      archiveSha256,
      changes: [
        "Add R2 method and byte counters.",
        "Accept existing 1,024-document groups in pair handlers; algorithms unchanged.",
        "Save the dictionary reference before launching its consumer.",
        "Compare total package bytes with storedBytes during publication; bytes measures verification sections.",
      ],
    },
    null,
    2,
  ),
);
console.log("Prepared control in", resolve(out));
