import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
// New credential shared only by isolated benchmark resources. Never reuse a
// production/demo secret as the credential of a newly deployed Worker.
export async function benchmarkToken() {
  await mkdir("work/columnar-deploy", { recursive: true });
  const path = "work/columnar-deploy/benchmark-token";
  let token = await readFile(path, "utf8").catch(() => "");
  if (!token) {
    token = randomBytes(32).toString("hex");
    await writeFile(path, token, { mode: 0o600 });
  }
  return token;
}
