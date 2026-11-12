import { buildColumnar } from './build.js';
const [input, out, max] = process.argv.slice(2);
await buildColumnar({ input, out, maxDocuments: Number(max) });
