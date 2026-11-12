import { addMicroPlans } from "../src/global/micro.js";
console.log(await addMicroPlans(process.argv[2] ?? "work/global-100k"));
