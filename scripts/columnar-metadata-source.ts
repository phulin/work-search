import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { DocumentDirectory } from "../src/columnar/document-directory.js";
import { view } from "../src/columnar/format.js";
import type { Root } from "../src/columnar/format.js";
/** Stream existing grouped packages in internal-ID order. Only inflate the
 * display metadata section; token, context, passage and excerpt bytes stay opaque.
 * Entirely local: no remote fallback or credentials. */
export async function* packageMetadata(
  index: string,
  store = process.env.CWS_LOCAL_DATA,
  expected?: Root,
) {
  const root: Root =
      expected ?? JSON.parse(await readFile(index + "/root.json", "utf8")),
    data = await readFile(index + "/documents.bin"),
    descriptor = root.documentPackages?.locators;
  if (
    !descriptor ||
    data.length !== descriptor.bytes ||
    createHash("sha256").update(data).digest("hex") !== descriptor.sha256
  )
    throw Error("Metadata source document directory identity mismatch");
  const directory = new DocumentDirectory(data);
  if (directory.count !== root.count)
    throw Error("Metadata source document count mismatch");
  for (const group of directory.groups()) {
    const data = await readFile(
      store
        ? `${store}/objects/${group.key}`
        : `${index}/packages/${group.key}`,
    );
    if (
      data.length !== group.bytes ||
      createHash("sha256").update(data).digest("hex") !==
        group.key.split("/")[0]
    )
      throw Error("Metadata source package identity mismatch");
    for (let doc = group.first; doc < group.end; doc++) {
      const loc = directory.lookup(doc),
        packet = data.subarray(loc.offset, loc.offset + loc.length),
        v = view(packet);
      if (
        packet.length < 64 ||
        v.getUint32(0, true) !== 0x32504443 ||
        v.getUint32(4, true) !== doc
      )
        throw Error("Metadata source document identity mismatch");
      const offset = v.getUint32(40, true),
        length = v.getUint32(44, true);
      if (offset < 64 || offset + length > packet.length)
        throw Error("Metadata source display range mismatch");
      const display = JSON.parse(
        gunzipSync(packet.subarray(offset, offset + length)).toString(),
      );
      yield { doc, metadata: display.metadata ?? {} };
    }
  }
}
