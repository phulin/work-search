/** Parse Wrangler's pretty-printed event stream, ignoring Yarn messages and an
 * incomplete final event when reading a file that is still being appended. */
export function constructionTail(raw: string) {
  const events: any[] = [];
  let depth = 0,
    start = -1,
    quoted = false,
    escape = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (start < 0) {
      if (c === "{" && (i === 0 || raw[i - 1] === "\n")) {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (quoted) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      events.push(JSON.parse(raw.slice(start, i + 1)));
      start = -1;
    }
  }
  return events;
}
