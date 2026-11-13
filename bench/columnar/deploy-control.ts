import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { benchmarkToken } from "./token.js";
const config = "work/columnar-control/wrangler.json";
for (const args of [
  ["deploy", "--config", config],
  ["secret", "put", "INTERNAL_TOKEN", "--config", config],
]) {
  const token = args[0] === "secret" ? await benchmarkToken() : undefined;
  await new Promise<void>((ok, no) => {
    const p = spawn("yarn", ["wrangler", ...args], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    p.stdin.end(token);
    p.once("error", no);
    p.once("exit", (c) => (c === 0 ? ok() : no(Error("Wrangler " + c))));
  });
}
