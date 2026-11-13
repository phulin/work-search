import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";

// JSONL records are delimited by LF (optionally CRLF). U+2028/U+2029 are legal
// JSON string contents, but recent Node readline versions treat them as lines.
export async function* jsonLines(path: string): AsyncGenerator<string> {
  let partial = "";
  const source = createReadStream(path),
    stream = path.endsWith(".gz") ? source.pipe(createGunzip()) : source;
  if (stream !== source) source.on("error", (e) => stream.destroy(e));
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    let scan = partial.length,
      start = 0;
    partial += chunk;
    while (true) {
      const end = partial.indexOf("\n", scan);
      if (end < 0) break;
      yield partial.slice(
        start,
        end > start && partial[end - 1] === "\r" ? end - 1 : end,
      );
      start = end + 1;
      scan = start;
    }
    partial = partial.slice(start);
  }
  if (partial.length)
    yield partial.endsWith("\r") ? partial.slice(0, -1) : partial;
}
