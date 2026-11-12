import { readdir, readFile } from "node:fs/promises";
import { parallel } from "../src/storage/types.js";
import { uploadCards } from "../scripts/upload-cards.js";
const root = "work/demo-bench/cards";
await parallel((await readdir(root)).sort(), 3, async (name) => {
  if (
    await readFile(root + "/" + name + "/manifest.json").then(
      () => true,
      () => false,
    )
  )
    await uploadCards(root + "/" + name);
});
