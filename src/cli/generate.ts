import { createWriteStream } from "node:fs";
import { once } from "node:events";
export async function generate(path: string, count: number, seed = 42) {
  let state = seed >>> 0;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const s = createWriteStream(path);
  for (let i = 0; i < count; i++) {
    const words = ["document", "search", "engine", `category${i % 100}`];
    for (let j = 0; j < 40; j++)
      words.push(`word${Math.floor(Math.pow(rand(), 3) * 20000)}`);
    const d = {
      id: `doc-${i}`,
      title: `Article category${i % 100} word${i % 20000}`,
      body: words.join(" "),
      metadata: { category: i % 100 },
    };
    if (!s.write(JSON.stringify(d) + "\n")) await once(s, "drain");
  }
  s.end();
  await once(s, "finish");
}
