import { buildColumnar } from "../src/columnar/build.js";
const [input, out, max] = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--"));
if (!input || !out)
  throw Error(
    "Usage: yarn columnar:build INPUT.jsonl[,INPUT...] OUT [MAX_DOCS]",
  );
const r = await buildColumnar({
  input: input.split(","),
  out,
  maxDocuments: max === undefined ? undefined : Number(max),
  resume: process.argv.includes("--resume"),
  ...(process.env.CWS_OFFLINE_STORE
    ? {
        remoteStore: {
          url: process.env.CWS_OFFLINE_STORE,
          tokenFile:
            process.env.CWS_OFFLINE_TOKEN_FILE ??
            "work/columnar-deploy/benchmark-token",
        },
      }
    : {}),
});
console.log(
  JSON.stringify({
    generation: r.generation,
    count: r.count,
    objects: r.objects.length,
  }),
);
