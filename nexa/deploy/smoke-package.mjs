import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const [archive, destination] = process.argv.slice(2);
if (!archive || !destination) throw Error("usage: smoke-package.mjs <archive> <new destination>");
const root = path.resolve(destination);
fs.mkdirSync(root, { mode: 0o700 });
const prefix = path.join(root, "runtime"),
  data = path.join(root, "data");
fs.mkdirSync(data, { mode: 0o700 });
const original = path.join(os.homedir(), ".omniroute-local");
fs.copyFileSync(path.join(original, ".env"), path.join(data, ".env"));
fs.chmodSync(path.join(data, ".env"), 0o600);
execFileSync("python3", [
  "-c",
  'import sqlite3,sys; source=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); dest=sqlite3.connect(sys.argv[2]); source.backup(dest); dest.close(); source.close()',
  path.join(original, "storage.sqlite"),
  path.join(data, "storage.sqlite"),
]);
fs.chmodSync(path.join(data, "storage.sqlite"), 0o600);
const installLog = fs.openSync(path.join(root, "install.log"), "w", 0o600);
execFileSync(
  "/usr/local/bin/node",
  [
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
    "install",
    "-g",
    "--prefix",
    prefix,
    "--no-fund",
    "--no-audit",
    path.resolve(archive),
  ],
  {
    stdio: ["ignore", installLog, installLog],
    env: {
      ...process.env,
      PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
      DATA_DIR: data,
    },
  }
);
fs.closeSync(installLog);
const freePort = async () => {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
};
const [port, wsPort, embedPort] = await Promise.all([freePort(), freePort(), freePort()]);
const pkg = path.join(prefix, "lib/node_modules/omniroute");
const output = fs.openSync(path.join(root, "server.log"), "w", 0o600);
const child = spawn(
  "/usr/local/bin/node",
  [path.join(pkg, "bin/omniroute.mjs"), "serve", "--no-open"],
  {
    detached: true,
    stdio: ["ignore", output, output],
    env: {
      ...process.env,
      PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
      DATA_DIR: data,
      PORT: String(port),
      OMNIROUTE_PORT: String(port),
      OMNIROUTE_SERVER_HOST: "127.0.0.1",
      HOSTNAME: "127.0.0.1",
      LIVE_WS_PORT: String(wsPort),
      EMBED_WS_PROXY_PORT: String(embedPort),
      MITM_AUTO_RECOVER: "false",
      OMNIROUTE_PLUGINS_DIR: path.join(data, "plugins"),
      DISABLE_SQLITE_AUTO_BACKUP: "true",
      NODE_OPTIONS: `--require=${path.join(original, "bridge-upstream-dns.cjs")}`,
    },
  }
);
try {
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(base + "/healthz", { signal: AbortSignal.timeout(3000) })).status === 200) {
        ready = true;
        break;
      }
    } catch {}
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw Error("Isolated package did not become healthy");
  process.env.DATA_DIR = data;
  const { apiFetch } = await import(pathToFileURL(path.join(pkg, "bin/cli/api.mjs")).href);
  for (const route of ["/api/settings", "/api/tools/agent-bridge/state", "/api/v1/models"]) {
    const response = await apiFetch(route, { baseUrl: base, maxAttempts: 1 });
    if (response.status !== 200) throw Error(`Isolated ${route}: HTTP ${response.status}`);
  }
  const cors = await fetch(base + "/api/settings", {
    headers: { Origin: "https://untrusted.invalid" },
    signal: AbortSignal.timeout(5000),
  });
  if (cors.headers.get("access-control-allow-origin") === "https://untrusted.invalid")
    throw Error("Untrusted origin was accepted");
  const result = {
    ok: true,
    isolated: true,
    serviceHealthy: true,
    managementAuth: true,
    bridgeState: true,
    modelCatalog: true,
    corsFailClosed: true,
    port,
    prefix,
    root,
  };
  fs.writeFileSync(path.join(root, "verification.json"), JSON.stringify(result, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify(result));
} finally {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await new Promise((r) => {
    if (child.exitCode !== null) return r();
    child.once("exit", r);
    setTimeout(r, 5000).unref();
  });
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
  fs.closeSync(output);
}
