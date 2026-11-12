// Publish a complete search snapshot: refresh directory, upload objects, then pin router membership.
import { spawn } from "node:child_process";
function run(file: string, args: string[] = []) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", file, ...args], {
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error(file + " failed " + code)),
    );
  });
}
await run("bench/build-demo-routes.ts", ["--all"]);
await run("scripts/upload-demo-routes.ts", [
  "--out",
  "work/full-flp/term-routes",
]);
await run("scripts/deploy-route-snapshot.ts");
