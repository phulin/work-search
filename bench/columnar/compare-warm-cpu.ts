import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fork } from "node:child_process";
import { LocalObjects } from "./local-storage.js";
import { SimulatedIO } from "./latency-model.js";
const [dir, pairDir, contractFile, out] = process.argv.slice(2);
if (!out)
  throw Error("Usage: compare-warm-cpu.ts INDEX PAIRS CONTRACTS OUTPUT");
const contract = JSON.parse(await readFile(contractFile, "utf8"));

if (process.env.CWS_CPU_CHILD) {
  const base = process.env.CWS_CPU_CHILD,
    load = (name: string) =>
      import(pathToFileURL(resolve(base, "src/columnar/" + name + ".ts")).href),
    [
      { ColumnarIndex },
      { Reader, Memory, Lru },
      { TermDirectory },
      { DocumentDirectory },
      { PairRouter },
    ] = await Promise.all(
      [
        "search",
        "storage",
        "term-directory",
        "document-directory",
        "pair-router",
      ].map(load),
    ),
    root = JSON.parse(await readFile(dir + "/root.json", "utf8")),
    source = new LocalObjects(
      root,
      process.env.CWS_LOCAL_DATA ?? "work/columnar-local-data",
    ),
    memory = new Memory();
  if (
    root.count !== 1000000 ||
    contract.count !== root.count ||
    contract.corpusHash !== root.corpusHash
  )
    throw Error("Expected matching 1M corpus");
  source.namedDirectory = pairDir;
  memory.pages = new Lru(12 * 1048576);
  const index = new ColumnarIndex(
      root,
      undefined,
      new TermDirectory(await readFile(dir + "/directory.bin"), root.count),
      undefined,
      new DocumentDirectory(await readFile(dir + "/documents.bin")),
      {
        router: new PairRouter(await readFile(pairDir + "/router.bin")),
        presence: JSON.parse(
          await readFile(pairDir + "/presence.json", "utf8"),
        ),
        N: 100,
        M: 1000,
      },
    ),
    io = new SimulatedIO(
      source,
      {
        r2Ms: 0,
        sharedMs: 0,
        r2MiBPerSecond: 100,
        sharedMiBPerSecond: 1000,
        jitterMs: 0,
        seed: 1,
      },
      1024,
    );
  io.delaysEnabled = false;
  let batchCpu: NodeJS.CpuUsage | undefined;
  process.on("message", async (message: any) => {
    try {
      let value: unknown;
      if (message.cmd === "start") batchCpu = process.cpuUsage();
      else if (message.cmd === "finish") {
        const cpu = process.cpuUsage(batchCpu);
        value = {
          cpuMs: (cpu.user + cpu.system) / 1000,
          downloads: source.downloads,
        };
      } else {
        const s = contract.scenarios[message.sid],
          deferred: Promise<unknown>[] = [],
          reader = new Reader(
            root,
            io.source,
            memory,
            io.shared,
            "warm-cpu",
            (p: Promise<unknown>) => deferred.push(p),
          ),
          cpu = process.cpuUsage(),
          start = performance.now(),
          result = await index.search(s.q, reader, s.options),
          body = JSON.stringify(result),
          wallMs = performance.now() - start,
          usage = process.cpuUsage(cpu);
        await Promise.all(deferred);
        if (
          result.results.length !== s.oracle.length ||
          result.results.some(
            (h: any, i: number) =>
              h.id !== s.oracle[i].id ||
              Math.abs(h.score - s.oracle[i].score) >
                1e-11 * Math.max(1, Math.abs(s.oracle[i].score)),
          )
        )
          throw Error("Oracle mismatch: " + s.q);
        value = {
          q: s.q,
          version: base,
          cpuMs: (usage.user + usage.system) / 1000,
          wallMs,
          responseBytes: body.length,
          resultSha256: createHash("sha256")
            .update(
              JSON.stringify(
                Object.fromEntries(
                  Object.entries(result).filter(([k]) => k !== "diagnostics"),
                ),
              ),
            )
            .digest("hex"),
          diagnostics: result.diagnostics,
        };
      }
      process.send!({ id: message.id, value });
    } catch (e) {
      process.send!({ id: message.id, error: String(e) });
    }
  });
  process.send!({
    ready: {
      version: base,
      generation: root.generation,
      search: createHash("sha256")
        .update(await readFile(resolve(base, "src/columnar/search.ts")))
        .digest("hex"),
      kernel: await readFile(resolve(base, "src/columnar/score-scan.ts"))
        .then((b) => createHash("sha256").update(b).digest("hex"))
        .catch((e) => {
          if (e.code !== "ENOENT") throw e;
          return null;
        }),
    },
  });
} else {
  const versions: {
    base: string;
    child: ReturnType<typeof fork>;
    ready: any;
    call: (cmd: string, sid?: number) => Promise<any>;
  }[] = [];
  let nextId = 0;
  for (const base of [
    process.env.CWS_CONTROL_SOURCE ?? "work/cpu-control-3572902",
    ".",
  ]) {
    const child = fork(new URL(import.meta.url), process.argv.slice(2), {
        env: { ...process.env, CWS_CPU_CHILD: base },
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      }),
      pending = new Map<
        number,
        { resolve: (x: any) => void; reject: (e: Error) => void }
      >();
    const ready = await new Promise<any>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== 0) {
          const e = Error("CPU child exited: " + code);
          reject(e);
          for (const p of pending.values()) p.reject(e);
        }
      });
      child.on("message", (m: any) => {
        if (m.ready) resolve(m.ready);
        else {
          const p = pending.get(m.id)!;
          pending.delete(m.id);
          if (m.error) p.reject(Error(m.error));
          else p.resolve(m.value);
        }
      });
    });
    const call = (cmd: string, sid?: number) =>
      new Promise<any>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        child.send({ id, cmd, sid });
      });
    versions.push({ base, child, ready, call });
  }
  try {
    const chosen = new Set([
        "summary judgment",
        "(rules OR of) AND rule",
        "(of OR the) AND limit",
        'court OR the OR of OR "and"',
        'court NOT "personal jurisdiction"',
        '(jurisdiction OR "summary judgment") AND NOT "res ipsa loquitur"',
        '"burden of proving"',
        '"in the absence of"',
      ]),
      repeats = Number(process.env.CWS_REPEATS ?? 30),
      rows: any[] = [],
      batches: any[] = [];
    const initialSeed = Number(process.env.CWS_SEED ?? 20261113);
    let seed = initialSeed;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    for (const [sid, s] of contract.scenarios.entries()) {
      if (!chosen.has(s.q)) continue;
      const hashes = new Set<string>(),
        run = async (v: (typeof versions)[number]) => {
          const row = await v.call("run", sid);
          hashes.add(row.resultSha256);
          if (hashes.size !== 1) throw Error("Exact response mismatch: " + s.q);
          return row;
        };
      for (let i = 0; i < 5; i++) for (const v of versions) await run(v);
      for (const v of versions) await v.call("start");
      for (let i = 0; i < repeats; i++)
        for (const v of random() & 1 ? versions : [...versions].reverse())
          rows.push({ ...(await run(v)), repeat: i });
      for (const v of versions) {
        const total = await v.call("finish");
        if (total.downloads) throw Error("Unexpected download");
        batches.push({
          q: s.q,
          version: v.base,
          n: repeats,
          cpuMs: total.cpuMs,
          meanCpuMs: total.cpuMs / repeats,
        });
      }
      console.log(
        s.q,
        batches.filter((r) => r.q === s.q),
      );
    }
    await mkdir(out, { recursive: true });
    await writeFile(
      out + "/cpu-only-" + (process.env.CWS_CPU_LABEL ?? "local") + ".json.gz",
      gzipSync(
        JSON.stringify({
          kind: "Local isolated-process CPU comparison; complete responses, no artificial I/O delays/inspector; requests randomly interleaved between independent processes",
          notes:
            "Batch CPU includes each version's background GC, deferred cache work and IPC between start/finish. Per-request CPU cannot attribute shared-heap GC reliably. Not Worker CPU or live latency.",
          node: process.version,
          source: versions.map((v) => v.ready),
          memoryPagesMiB: 12,
          sharedCacheMiB: 1024,
          seed: initialSeed,
          warmups: 5,
          repeats,
          rows,
          batches,
        }),
      ),
    );
  } finally {
    for (const v of versions) {
      v.child.disconnect();
      v.child.kill();
    }
  }
}
