import { createHash } from "node:crypto";
export function sourceVerifier(manifest: any) {
  const identities = manifest.buildIdentity
    ? [manifest.buildIdentity]
    : [false, true].map((pagedStaging) => ({
        version: manifest.format,
        ...(pagedStaging ? { pagedStaging: true } : {}),
        budget: manifest.budget,
        strategy: manifest.strategy,
        workload: [],
        objectBytes: 64 * 1048576,
      }));
  const hashes = identities.map((i) =>
    createHash("sha256").update(JSON.stringify(i)),
  );
  return {
    add(document: unknown) {
      const text = JSON.stringify(document) + "\n";
      for (const h of hashes) h.update(text);
    },
    verify(generation: string) {
      if (!hashes.map((h) => h.digest("hex")).includes(generation))
        throw Error(
          "Source generation does not match the input or supported default build settings; rebuild with global:build without --source",
        );
    },
  };
}
