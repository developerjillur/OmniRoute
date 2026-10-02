import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const [archive, destination] = process.argv.slice(2);
if (!archive || !destination) throw Error("usage: smoke-package.mjs <archive> <new destination>");
const root = path.resolve(destination);
const reuse = process.argv.includes("--reuse");
if (!reuse) fs.mkdirSync(root, { mode: 0o700 });
const prefix = path.join(root, "runtime"),
  data = path.join(root, "data");
const original = path.join(os.homedir(), ".omniroute-local");
if (!reuse) {
  fs.mkdirSync(data, { mode: 0o700 });
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
}
const installedServer = fs.readFileSync(
  path.join(prefix, "lib/node_modules/omniroute/src/mitm/server.cjs")
);
const archivedServer = execFileSync("tar", [
  "-xOf",
  path.resolve(archive),
  "package/src/mitm/server.cjs",
]);
if (!installedServer.equals(archivedServer))
  throw Error("Installed smoke prefix does not match the archive");
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
  const localKey = execFileSync(
    "python3",
    [
      "-c",
      "import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); row=c.execute(\"SELECT key FROM api_keys WHERE is_active=1 AND revoked_at IS NULL AND is_banned=0 ORDER BY CASE WHEN scopes LIKE '%manage%' THEN 0 ELSE 1 END LIMIT 1\").fetchone(); print(row[0] if row else '',end='')",
      path.join(data, "storage.sqlite"),
    ],
    { encoding: "utf8" }
  );
  if (!localKey) throw Error("An existing local inference key is required for package smoke");
  for (const route of ["/api/settings", "/api/tools/agent-bridge/state", "/api/v1/models"]) {
    const response = await apiFetch(route, { baseUrl: base, apiKey: localKey, retry: false });
    if (response.status !== 200) throw Error(`Isolated ${route}: HTTP ${response.status}`);
    if (route.endsWith("agent-bridge/state")) {
      const state = await response.json();
      if (state.serverState.port !== 8443)
        throw Error("Packaged Bridge state lost the configured port");
    }
  }
  const inference = await apiFetch("/v1/messages", {
    baseUrl: base,
    apiKey: localKey,
    retry: false,
    timeout: 120000,
    method: "POST",
    headers: { "anthropic-version": "2023-06-01" },
    body: {
      model: "cc/claude-opus-5-5",
      max_tokens: 64,
      stream: false,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "Respond with exactly ISOLATED_BRIDGE_OK" }],
    },
  });
  const inferred = await inference.json();
  if (
    inference.status !== 200 ||
    inferred.type !== "message" ||
    !inferred.content?.some((c) => c.text?.includes("ISOLATED_BRIDGE_OK"))
  )
    throw Error(`Isolated Anthropic inference failed: HTTP ${inference.status}`);
  const cors = await fetch(base + "/api/settings", {
    headers: { Origin: "https://untrusted.invalid" },
    signal: AbortSignal.timeout(5000),
  });
  if (["*", "https://untrusted.invalid"].includes(cors.headers.get("access-control-allow-origin")))
    throw Error("Untrusted origin was accepted");
  const result = {
    ok: true,
    isolated: true,
    serviceHealthy: true,
    managementAuth: true,
    bridgeState: true,
    modelCatalog: true,
    anthropicInference: true,
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
