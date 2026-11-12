import { spawn } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
const variants = [
  { name: "work-search-global-heads48", page: "256", heads: "1", budget: "48" },
  { name: "work-search-global-p128", page: "128" },
  { name: "work-search-global-p256", page: "256" },
  { name: "work-search-global-heads", page: "256", heads: "1" },
  {
    name: "work-search-global-smart",
    page: "256",
    heads: "1",
    placement: "smart",
  },
  {
    name: "work-search-global-east",
    page: "256",
    heads: "1",
    placement: "aws:us-east-1",
  },
];
for (const v of variants) {
  const log = await open(`work/global-bench/deploy-${v.name}.log`, "w");
  try {
    await new Promise<void>((resolve, reject) => {
      const c = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/deploy-global.ts",
          "work/global-100k",
          "--deploy-only",
        ],
        {
          stdio: ["ignore", log.fd, log.fd],
          env: {
            ...process.env,
            GLOBAL_WORKER: v.name,
            GLOBAL_BUDGET: v.budget ?? "8",
            GLOBAL_PAGE_KIB: v.page,
            GLOBAL_HEADS: v.heads ?? "0",
            ...(v.placement ? { GLOBAL_PLACEMENT: v.placement } : {}),
          },
        },
      );
      c.once("error", reject);
      c.once("exit", (code) =>
        code === 0 ? resolve() : reject(Error(v.name + " failed " + code)),
      );
    });
  } finally {
    await log.close();
  }
  console.log("Deployed", v.name);
}
await writeFile(
  "work/global-bench/variants.json",
  JSON.stringify(
    [
      { name: "work-search-global-old", engine: "old" },
      { name: "work-search-global", page: "64" },
      ...variants,
    ],
    null,
    2,
  ),
);
