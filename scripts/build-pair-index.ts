import { buildPairs } from "../src/global/pair-build.js";
const args = process.argv.slice(2),
  inlineRarePairs = args.includes("--inline-rare"),
  rootAt = args.indexOf("--max-root-bytes"),
  maxRootBytes = rootAt < 0 ? undefined : Number(args[rootAt + 1]);
const [input, source, base, out, mib = "32", vocabulary = "4096"] = args.filter(
  (arg, i) =>
    arg !== "--inline-rare" &&
    !(rootAt >= 0 && (i === rootAt || i === rootAt + 1)),
);
if (!out)
  throw Error(
    "Usage: tsx scripts/build-pair-index.ts INPUT SOURCE BASE OUT [MiB] [VOCABULARY] [--inline-rare] [--max-root-bytes N]",
  );
console.log(
  JSON.stringify(
    await buildPairs({
      input,
      source,
      base,
      out,
      budgetBytes: Number(mib) * 1048576,
      vocabulary: Number(vocabulary),
      inlineRarePairs,
      maxRootBytes,
    }),
    null,
    2,
  ),
);
