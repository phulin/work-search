import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { spawn } from "node:child_process";
const [label, command, ...args] = process.argv.slice(2);
if (!command) throw Error("Usage: after-run.ts RUN_LABEL COMMAND [ARGS...]");
console.log("Waiting for benchmark completion", label);
// A raw run can be hundreds of MiB. Poll its lightweight completion receipt;
// the old whole-file gunzip loop competed with the measured client process.
let polls = 0;
for (;;) {
  const receipt = await readFile(
    `work/columnar-bench/${label}-complete.json`,
  ).then(
    () => true,
    () => false,
  );
  if (receipt) break;
  const done =
    polls++ % 12 === 0 &&
    (await readFile(`work/columnar-bench/${label}.json.gz`).then(
      (b) => JSON.parse(gunzipSync(b).toString()).manifest.finishedAt,
      () => undefined,
    ));
  if (done) break;
  await new Promise((r) => setTimeout(r, 5000));
}
console.log(
  "Benchmark completed; starting deferred work",
  new Date().toISOString(),
);
await new Promise<void>((ok, no) => {
  const child = spawn(command, args, { stdio: "inherit" });
  child.once("error", no);
  child.once("exit", (code) =>
    code === 0 ? ok() : no(Error("Deferred command exited " + code)),
  );
});
