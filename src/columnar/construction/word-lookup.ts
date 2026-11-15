import { Lru } from "../storage.js";
import { WordDirectory } from "../word-directory.js";
import type { BuildStore, Chunk } from "./runs.js";
export interface WordPacket {
  first: string;
  last: string;
  firstId: number;
  count: number;
  ref: Chunk;
}
export interface ConstructionWords {
  generation: string;
  count: number;
  rootSha256: string;
  hot: Uint8Array;
  ids: Uint32Array;
  packets: WordPacket[];
}
/** A small common-word bundle plus a complete, directly routed R2 dictionary.
 * Only validated numeric/string data survive invocations; pending I/O does not. */
export class ConstructionWordLookup {
  private hot: WordDirectory;
  private cache = new Lru<WordDirectory>(8 * 1048576);
  constructor(readonly config: ConstructionWords) {
    this.hot = new WordDirectory(config.hot);
    if (this.hot.count !== config.ids.length)
      throw Error("Construction hot ID count mismatch");
    let next = 1;
    config.packets.forEach((p, i) => {
      if (
        p.firstId !== next ||
        !p.count ||
        p.first > p.last ||
        (i && config.packets[i - 1].last >= p.first) ||
        p.ref.size > 2 * 1048576
      )
        throw Error("Invalid construction word routing");
      next += p.count;
    });
    if (
      config.ids.some(
        (id, i) => !id || id >= next || (i > 0 && id <= config.ids[i - 1]),
      )
    )
      throw Error("Invalid construction hot IDs");
  }
  request(store: BuildStore) {
    const stats = { requests: 0, bytes: 0, hits: 0, misses: 0, packetHits: 0 };
    return {
      generation: this.config.generation,
      stats,
      lookup: async (names: string[]) => {
        const local = await this.hot.lookup(names),
          found = new Map<string, number>(),
          routes = new Map<number, string[]>();
        for (const name of names) {
          const id = local.get(name);
          if (id !== undefined) {
            found.set(name, this.config.ids[id - 1]);
            stats.hits++;
            continue;
          }
          stats.misses++;
          let lo = 0,
            hi = this.config.packets.length;
          while (lo < hi) {
            const m = (lo + hi) >>> 1;
            if (this.config.packets[m].last < name) lo = m + 1;
            else hi = m;
          }
          if (
            lo < this.config.packets.length &&
            this.config.packets[lo].first <= name
          ) {
            const group = routes.get(lo) ?? [];
            group.push(name);
            routes.set(lo, group);
          }
        }
        const groups = [...routes];
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(6, groups.length) }, async () => {
            for (;;) {
              const i = next++;
              if (i >= groups.length) return;
              const [index, wanted] = groups[i],
                packet = this.config.packets[index];
              let directory = this.cache.get(packet.ref.sha256);
              if (!directory) {
                const raw = await store.get(packet.ref);
                stats.requests++;
                stats.bytes += raw.length;
                directory = new WordDirectory(raw, 65536);
                if (directory.count !== packet.count)
                  throw Error("Construction word packet count mismatch");
                // Include the bounded decoded-word cache and routing/key overhead.
                this.cache.set(
                  packet.ref.sha256,
                  directory,
                  raw.length + 65536 + packet.count / 16,
                );
              } else stats.packetHits++;
              for (const [word, ordinal] of await directory.lookup(wanted))
                found.set(word, packet.firstId + ordinal - 1);
            }
          }),
        );
        return found;
      },
    };
  }
}
