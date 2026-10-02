import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

export function buildEnvironment(env = process.env) {
  const heap = Number(env.NEXA_BUILD_HEAP_MB || 6144);
  const workers = Number(env.NEXA_BUILD_WORKERS || 1);
  if (!Number.isInteger(heap) || heap < 1024 || heap > 6144)
    throw Error("Build heap must be 1024..6144 MiB");
  if (!Number.isInteger(workers) || workers < 1 || workers > 2)
    throw Error("Build workers must be 1 or 2");
  const options = (env.NODE_OPTIONS || "")
    .replace(/--max[-_]old[-_]space[-_]size(?:=|\s+)\d+/g, "")
    .trim();
  return {
    ...env,
    PATH:
      process.platform === "darwin"
        ? `/usr/local/bin:${env.PATH || process.env.PATH || "/usr/bin:/bin"}`
        : env.PATH,
    NODE_OPTIONS: `${options} --max-old-space-size=${heap}`.trim(),
    OMNIROUTE_BUILD_MEMORY_MB: String(heap),
    NEXA_BUILD_WORKERS: String(workers),
    OMNIROUTE_USE_TURBOPACK: "0",
    UV_THREADPOOL_SIZE: "2",
  };
}

export function descendantRss(ps, rootPid) {
  const rows = ps
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((r) => r.length === 3 && r.every(Number.isFinite));
  const owned = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of rows)
      if (owned.has(parent) && !owned.has(pid)) {
        owned.add(pid);
        changed = true;
      }
  }
  return rows.filter(([pid]) => owned.has(pid)).reduce((sum, row) => sum + row[2] * 1024, 0);
}

export async function runBounded(
  command,
  args,
  { env = process.env, limitMiB = Number(env.NEXA_BUILD_RSS_MB || 8192), intervalMs = 1000 } = {}
) {
  if (!command || !Number.isFinite(limitMiB) || limitMiB <= 0)
    throw Error("A command and positive RSS limit are required");
  const child = spawn("/usr/bin/nice", ["-n", "10", command, ...args], {
    env: buildEnvironment(env),
    detached: true,
    stdio: "inherit",
  });
  let peakBytes = 0,
    stopped = false,
    reason = "",
    forceKill;
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  };
  const stop = (why) => {
    if (stopped) return;
    stopped = true;
    reason = why;
    console.error(`[build-budget] ${why}; stopping only this build process group`);
    signalGroup("SIGTERM");
    forceKill = setTimeout(() => signalGroup("SIGKILL"), 2000);
  };
  const cancel = () => stop("Build cancelled");
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const timer = setInterval(() => {
    try {
      const rss = descendantRss(
        execFileSync("/bin/ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8", timeout: 2000 }),
        child.pid
      );
      peakBytes = Math.max(peakBytes, rss);
      if (rss > limitMiB * 1024 ** 2)
        stop(`RSS budget exceeded (${Math.ceil(rss / 1024 ** 2)} > ${limitMiB} MiB)`);
    } catch (e) {
      stop(`Cannot monitor build memory: ${e.code || "measurement failed"}`);
    }
  }, intervalMs);
  const result = await new Promise((resolve) => {
    child.once("error", (e) => resolve({ code: 1, error: e.code }));
    child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
  clearInterval(timer);
  if (stopped) {
    signalGroup("SIGKILL");
    clearTimeout(forceKill);
  }
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
  const report = {
    ...result,
    code: stopped ? 75 : result.code,
    peakMiB: Math.ceil(peakBytes / 1024 ** 2),
    limitMiB,
    stopped,
    reason,
  };
  console.log(`[build-budget] ${JSON.stringify(report)}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.shift() !== "--") throw Error("Usage: run-bounded-build.mjs -- command [args]");
  const result = await runBounded(args.shift(), args);
  process.exitCode = result.code;
}
