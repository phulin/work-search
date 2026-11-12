import { spawn } from "node:child_process";
import { once } from "node:events";
import { tokenOffsets } from "../../src/global/build.js";
const binary = process.argv[2] ?? "target/release/work-search-builder";
const child = spawn(binary, ["tokens"], { stdio: ["pipe", "pipe", "inherit"] });
const expected: string[] = [];
let partial = "",
  checked = 0,
  mismatch: Error | undefined;
child.stdout.setEncoding("utf8");
child.stdout.on("data", (s: string) => {
  partial += s;
  for (;;) {
    const end = partial.indexOf("\n");
    if (end < 0) break;
    const line = partial.slice(0, end);
    partial = partial.slice(end + 1);
    const want = expected.shift();
    const actual = JSON.parse(line);
    const canonical = JSON.stringify({
      text: actual.text,
      terms: actual.terms,
      starts: actual.starts,
      ends: actual.ends,
    });
    if (want !== canonical && !mismatch)
      mismatch = Error(
        "Unicode/token-offset mismatch at batch " +
          checked +
          "\n" +
          canonical.slice(0, 1000) +
          "\n" +
          want?.slice(0, 1000),
      );
    checked++;
  }
});
async function send(text: string) {
  expected.push(JSON.stringify(tokenOffsets(text)));
  if (!child.stdin.write(JSON.stringify(text) + "\n"))
    await once(child.stdin, "drain");
}
let batch: string[] = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  batch.push(String.fromCodePoint(cp));
  if (batch.length === 512) {
    await send(batch.join(" "));
    batch = [];
  }
}
if (batch.length) await send(batch.join(" "));
for (const s of [
  "A\u030a\u0301 İ ΟΣ 𝔄 ½",
  "ΟΣ ΟΣΑ ΣΟΣ Σ\u0345Σ Ο\u0301Σ",
  "😀\u{1e030}x \u212b\u0323\u0301",
  "\ufdfa".repeat(30),
  "a\u0315\u0300\u05ae\u0301\u0327",
])
  await send(s);
let seed = 17;
for (let i = 0; i < 1000; i++) {
  let s = "";
  for (let j = 0; j < 128; j++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const cp = seed % 0x110000;
    if (cp < 0xd800 || cp > 0xdfff) s += String.fromCodePoint(cp);
  }
  await send(s);
}
child.stdin.end();
const [code] = await once(child, "exit");
if (code || mismatch || expected.length || partial)
  throw mismatch ?? Error("Unicode verifier incomplete: " + code);
console.log(
  JSON.stringify({
    validUnicodeScalars: 1112064,
    extraRandomCases: 1000,
    checkedBatches: checked,
    unicode: process.versions.unicode,
    node: process.version,
  }),
);
