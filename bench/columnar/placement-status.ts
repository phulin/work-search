import { execFile } from "node:child_process";
import { promisify } from "node:util";
const { stdout } = await promisify(execFile)(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js",
    "auth",
    "token",
    "--json",
  ]),
  token = JSON.parse(stdout).token;
for (const name of process.argv.slice(2)) {
  const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/8f088d4bd190caf693cc42bb8311fd7d/workers/services/${name}`,
      { headers: { authorization: `Bearer ${token}` } },
    ),
    body = (await response.json()) as any;
  if (!body.success) throw Error("Placement API " + response.status);
  const environment = body.result.default_environment,
    script = environment?.script;
  console.log(
    JSON.stringify({
      name,
      environment: environment?.environment,
      placement: script?.placement,
      version: script?.id,
      scriptKeys: Object.keys(script ?? {}),
    }),
  );
}
