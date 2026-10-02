import fs from "node:fs";
import path from "node:path";

export function readBridgeRuntimeStatus(certDir: string, running: boolean) {
  const parsedPort = Number(process.env.MITM_LOCAL_PORT || 443);
  const port =
    Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 443;
  let stats: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(certDir, "stats.json"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stats = parsed;
  } catch {
    /* No successful listener yet. */
  }
  const count = (name: string) =>
    typeof stats[name] === "number" &&
    Number.isSafeInteger(stats[name]) &&
    (stats[name] as number) >= 0
      ? (stats[name] as number)
      : 0;
  return {
    port,
    activeConns: running ? count("activeConnections") : 0,
    interceptedCount: count("interceptedRequests"),
    totalRequests: count("totalRequests"),
    lastStartedAt: typeof stats.startedAt === "string" ? stats.startedAt : null,
  };
}

export function readBridgeIntent(certDir: string): boolean {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(certDir, "runtime-intent.json"), "utf8")).enabled ===
      true
    );
  } catch {
    return false;
  }
}

export function writeBridgeIntent(certDir: string, enabled: boolean): void {
  fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });
  const target = path.join(certDir, "runtime-intent.json");
  const staged = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(staged, JSON.stringify({ version: 1, enabled }) + "\n", { mode: 0o600 });
  fs.renameSync(staged, target);
}

export function shouldRecoverBridge(
  env: NodeJS.ProcessEnv,
  enabled: boolean,
  running: boolean
): boolean {
  return env.MITM_AUTO_RECOVER === "true" && enabled && !running;
}
