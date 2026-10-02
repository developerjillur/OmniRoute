import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export function inspectServerContract(source) {
  return [
    "MITM_TARGET_AGENT",
    "decodeChatBody",
    "retainedHeaders",
    "response.status",
    "response.headers.entries()",
    "rawBodyBuffer",
    "MITM_LOCAL_HOST",
    "/__omniroute_bridge_health",
  ].every((value) => source.includes(value));
}

export function verifyPackage(archive, { allowPriorLifecycle = false } = {}) {
  const members = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).split("\n");
  const read = (member) =>
    execFileSync("tar", ["-xOf", archive, member], { maxBuffer: 16 * 1024 * 1024 });
  const cliPid = read("package/bin/cli/utils/pid.mjs").toString();
  if (!cliPid.includes('"-sTCP:LISTEN"'))
    throw new Error("Archive has the client-socket false-positive startup bug");
  const source = read("package/src/mitm/server.cjs");
  const dist = read("package/dist/src/mitm/server.cjs");
  if (!source.equals(dist) || !inspectServerContract(source.toString()))
    throw new Error("Archive lacks the verified native Bridge transport contract");
  for (const member of [
    "package/src/mitm/runtimeState.ts",
    "package/src/mitm/bootRecovery.ts",
    "package/src/mitm/inspector/eventStream.ts",
  ]) {
    if (!members.includes(member)) throw new Error(`Archive lacks ${member}`);
  }
  const lifecycleMember = "package/src/mitm/processLifecycle.ts";
  const lifecyclePresent = members.includes(lifecycleMember);
  if (!allowPriorLifecycle) {
    if (!lifecyclePresent) throw new Error("Archive lacks shared Bridge process ownership");
    if (
      !read("package/open-sse/config/anthropicHeaders.ts")
        .toString()
        .includes("message-threads-2026-08-12")
    )
      throw new Error("Archive drops native message-thread beta negotiation");
    const processState = read(lifecycleMember).toString();
    const runtimeManager = read("package/dist/src/mitm/manager.ts").toString();
    if (
      !processState.includes("omniroute.mitm.process-lifecycle.v1") ||
      !runtimeManager.includes("getBridgeProcessState") ||
      !read("package/dist/src/mitm/processLifecycle.ts").equals(read(lifecycleMember)) ||
      !source.toString().includes("void handleRequest(req, res).catch") ||
      !source.toString().includes("for (const socket of sockets) socket.destroy()")
    ) {
      throw new Error("Archive lacks Bridge lifecycle or request failure isolation");
    }
  }
  const manifest = members.find((p) => p.endsWith("/server/app-paths-manifest.json"));
  if (!manifest || !read(manifest).toString().includes("traffic-inspector/events/route"))
    throw new Error("Archive lacks the compiled inspector event stream route");
  return {
    ok: true,
    sourceAndDistMatch: true,
    sharedLifecycle: lifecyclePresent,
    serverSha256: createHash("sha256").update(source).digest("hex"),
  };
}

function tlsProbe(port, ca, hostname) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      {
        hostname: "127.0.0.1",
        port,
        servername: hostname,
        ca,
        rejectUnauthorized: true,
        headers: { Host: hostname },
        path: "/__omniroute_bridge_health",
        timeout: 5000,
      },
      (response) => {
        let body = "";
        response.on("data", (data) => (body += data));
        response.on("end", () => {
          try {
            const value = JSON.parse(body);
            if (response.statusCode !== 200 || value.transportVersion !== 1 || !value.ok)
              throw new Error("Bridge transport health contract failed");
            resolve(value);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error("Bridge TLS probe timed out")));
    request.on("error", reject);
  });
}

export function verifyNativeIngress() {
  const installed = "/Library/Application Support/OmniRoute-Native-Ingress/native-ingress.mjs";
  const stat = fs.lstatSync(installed);
  const source = fs.readFileSync(installed, "utf8");
  if (
    !stat.isFile() ||
    stat.uid !== 0 ||
    (stat.mode & 0o022) !== 0 ||
    !source.includes("export function inspectClientHello") ||
    !source.includes('localRouterHost = "127.0.0.2"') ||
    !source.includes('if (host === "api.anthropic.com")')
  )
    throw new Error(
      "Install the scoped native ingress helper with install-native-ingress.sh before updating; live service left unchanged"
    );
  return { ok: true, nativeIngressScoped: true, rootOwned: true };
}

export async function verifyLive(dataDir = path.join(os.homedir(), ".omniroute-local")) {
  const nativeIngress = verifyNativeIngress();
  const dir = path.join(dataDir, "mitm");
  const intent = JSON.parse(fs.readFileSync(path.join(dir, "runtime-intent.json"), "utf8"));
  if (!intent.enabled) return { ...nativeIngress, bridgeEnabled: false };
  const ca = fs.readFileSync(path.join(dir, "ca.crt"));
  const backend = await tlsProbe(8443, ca, "api.anthropic.com");
  const ingress = await tlsProbe(443, ca, "api.anthropic.com");
  if (backend.targetAgent !== "claude-code" || ingress.targetAgent !== "claude-code")
    throw new Error("Wrong agent owns the native Claude host");
  const hosts = fs.readFileSync("/etc/hosts", "utf8");
  if (
    !hosts.split("\n").some((line) => /^\s*127\.0\.0\.1\s+api\.anthropic\.com(?:\s|$)/.test(line))
  )
    throw new Error("Claude hosts routing is missing");
  return {
    ok: true,
    bridgeEnabled: true,
    backendTlsVerified: true,
    ingressTlsVerified: true,
    targetAgent: "claude-code",
    nativeIngressScoped: true,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2];
    const result =
      mode === "package"
        ? verifyPackage(process.argv[3], {
            allowPriorLifecycle: process.argv.includes("--allow-prior-lifecycle"),
          })
        : mode === "ingress"
          ? verifyNativeIngress()
          : mode === "live"
            ? await verifyLive(process.argv[3])
            : (() => {
                throw new Error("usage: bridge-gate.mjs package <tgz> | ingress | live [dataDir]");
              })();
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
