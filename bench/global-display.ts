import { addDisplaySeeds } from "../src/global/display.js";
console.log(await addDisplaySeeds(process.argv[2] ?? "work/global-100k"));
