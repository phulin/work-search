/** Local range adapter for the actual bundled Worker; never accesses the network. */
import { open } from "node:fs/promises";
import { DocumentDirectory } from "../../src/columnar/document-directory.js";
import type { ServingAssets } from "../../scripts/columnar-serving.js";
export function localProfileStorage(dir: string, assets: ServingAssets) {
  if (!assets.documents)
    throw Error("Missing document directory for local profile");
  const files = new Map<
    string,
    { path: string; size: number; meta: Record<string, string> }
  >();
  for (const object of assets.root.objects) {
    const key = object.key ?? `${assets.root.generation}/${object.name}`;
    files.set(key, {
      path: dir + "/packs/" + object.name,
      size: object.size,
      meta: { generation: key.split("/")[0], sha256: object.sha256 },
    });
  }
  for (const g of new DocumentDirectory(assets.documents).groups())
    files.set(g.key, {
      path: dir + "/objects/" + g.key,
      size: g.bytes,
      meta: {
        generation: g.key.split("/")[0],
        sha256: g.key.split("/")[0],
        packageFirst: String(g.first),
        packageEnd: String(g.end),
      },
    });
  for (const object of assets.auxiliary)
    files.set(object.key, {
      path: object.path,
      size: object.size,
      meta: {
        generation: object.key.split("/")[0],
        sha256: object.key.split("/")[0],
      },
    });
  return async (request: Request) => {
    const key = new URL(request.url).pathname.slice(1),
      file = files.get(key),
      offset = Number(request.headers.get("offset")),
      requestedLength = Number(request.headers.get("length")),
      length = requestedLength || file?.size || 0;
    if (
      !file ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      (!requestedLength && offset !== 0) ||
      length < 1 ||
      offset + length > file.size
    )
      return new Response("Invalid local profile range", { status: 400 });
    const handle = await open(file.path, "r"),
      bytes = Buffer.allocUnsafe(length);
    try {
      let at = 0;
      while (at < length) {
        const { bytesRead } = await handle.read(
          bytes,
          at,
          length - at,
          offset + at,
        );
        if (!bytesRead) throw Error("Truncated local profile object");
        at += bytesRead;
      }
    } finally {
      await handle.close();
    }
    return new Response(bytes, {
      headers: {
        "x-cws-meta": JSON.stringify(file.meta),
        "x-cws-size": String(file.size),
      },
    });
  };
}
