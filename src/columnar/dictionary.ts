import type { Root } from "./format.js";
import type { Reader } from "./storage.js";
export async function loadDictionary<T>(
  names: string[],
  reader: Reader,
  routing: Pick<Root, "dictionaries" | "dictionaryHeight"> & {
    hot: Record<string, T>;
  },
) {
  const terms = new Map<string, T>(),
    cold: string[] = [];
  for (const name of names) {
    const hot = Object.hasOwn(routing.hot, name)
      ? routing.hot[name]
      : undefined;
    if (hot) terms.set(name, hot);
    else cold.push(name);
  }
  const visit = async (
    ds: Root["dictionaries"],
    names: string[],
    height: number,
  ): Promise<void> => {
    const routes = new Map<number, string[]>();
    for (const name of names) {
      let l = 0,
        r = ds.length;
      while (l < r) {
        const m = (l + r) >>> 1;
        if (ds[m].last < name) l = m + 1;
        else r = m;
      }
      if (l < ds.length && ds[l].first <= name) {
        const a = routes.get(l) ?? [];
        a.push(name);
        routes.set(l, a);
      }
    }
    if (routes.size) reader.stats.stages++;
    await Promise.all(
      [...routes].map(async ([i, names]) => {
        const ref = ds[i].ref;
        if (height)
          return visit(
            await reader.load(
              ref,
              (b) =>
                JSON.parse(new TextDecoder().decode(b)) as Root["dictionaries"],
              ref[2] * 3,
            ),
            names,
            height - 1,
          );
        const entries = await reader.load(
          ref,
          (b) => new Map<string, T>(JSON.parse(new TextDecoder().decode(b))),
          ref[2] * 3,
        );
        for (const name of names) {
          const term = entries.get(name);
          if (term) terms.set(name, term);
        }
      }),
    );
  };
  await visit(routing.dictionaries, cold, routing.dictionaryHeight ?? 0);
  return terms;
}
