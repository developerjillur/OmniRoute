import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import { lookup } from "node:dns/promises";
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

export function inspectCompiledCountRoute(source) {
  return /countTokens[\s\S]{0,180}clientHeaders:Object\.fromEntries\([^)]*\.headers\.entries\(\)\),signal:/.test(
    source
  );
}

export function verifyPackage(archive, { allowPriorLifecycle = false } = {}) {
  const members = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).split("\n");
  const read = (member) =>
    execFileSync("tar", ["-xOf", archive, member], { maxBuffer: 64 * 1024 * 1024 });
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
    if (!read("package/open-sse/executors/base.ts").toString().includes("legacyThinkingModel"))
      throw new Error("Archive injects unsupported adaptive thinking into legacy Claude models");
    if (
      !read("package/open-sse/executors/claudeIdentity.ts")
        .toString()
        .includes("modelSupportsContext1mBeta(claudeModel)")
    )
      throw new Error("Archive forces unsupported legacy Claude long-context beta");
    const threadCache = read("package/open-sse/services/claudeCodeConstraints.ts").toString();
    if (
      !threadCache.includes("getCacheControlBudget(body)") ||
      !threadCache.includes("enforceCacheControlLimit(body);")
    )
      throw new Error("Archive exceeds the native thread cache-marker budget");
    if (
      !read("package/open-sse/config/anthropicHeaders.ts")
        .toString()
        .includes("preserveNativeClientBetas") ||
      !read("package/open-sse/executors/base.ts").toString().includes("Boolean(isClaudeCodeClient)")
    )
      throw new Error("Archive silently drops native Claude protocol negotiation");
    if (
      !read("package/open-sse/executors/base.ts")
        .toString()
        .includes("this.buildHeaders(credentials, false, clientHeaders, model, undefined, body)")
    )
      throw new Error("Archive loses body-dependent token-count header eligibility");
    const countRoute = read(
      "package/dist/.build/next/server/app/api/v1/messages/count_tokens/route.js"
    ).toString();
    const countChunks = [...countRoute.matchAll(/R\.c\("(server\/chunks\/[^"\n]+)"\)/g)].map(
      (match) => `package/dist/.build/next/${match[1]}`
    );
    // Webpack keeps this handler in route.js; Turbopack places it in referenced chunks.
    if (!inspectCompiledCountRoute(countRoute)) {
      execFileSync(
        "python3",
        [
          "-c",
          `
import json,re,sys,tarfile
wanted=set(json.loads(sys.argv[2]))
pattern=rb'countTokens[\\s\\S]{0,180}clientHeaders:Object\\.fromEntries\\([^)]*\\.headers\\.entries\\(\\)\\),signal:'
with tarfile.open(sys.argv[1], 'r|gz') as archive:
    for member in archive:
        if member.name in wanted and re.search(pattern,archive.extractfile(member).read()):
            sys.exit(0)
raise SystemExit('Compiled token-count route drops native protocol headers or cancellation')
`,
          archive,
          JSON.stringify(countChunks),
        ],
        { stdio: "pipe", maxBuffer: 1024 * 1024 }
      );
    }
    const processState = read(lifecycleMember).toString();
    const runtimeManager = read("package/dist/src/mitm/manager.ts").toString();
    if (
      !processState.includes("omniroute.mitm.process-lifecycle.v1") ||
      !runtimeManager.includes("getBridgeProcessState") ||
      !runtimeManager.includes("waitForBridgeReady") ||
      !runtimeManager.includes("isOwnedBridgePid") ||
      !processState.includes("terminateBridgeChild") ||
      !read("package/dist/src/mitm/processLifecycle.ts").equals(read(lifecycleMember)) ||
      !source.toString().includes("void handleRequest(req, res).catch") ||
      !source.toString().includes("for (const socket of sockets) socket.destroy()") ||
      !source.toString().includes("upstreamResponse?.destroy()") ||
      !source.toString().includes('nativeUrl.pathname === "/v1/messages/count_tokens"') ||
      !source.toString().includes("writeWithBackpressure(res, value)")
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
    !source.includes("OMNI_LISTEN_FDS") ||
    !source.includes('localRouterHost = "127.0.0.2"') ||
    !source.includes('if (host === "api.anthropic.com")')
  )
    throw new Error(
      "Install the scoped native ingress helper with install-native-ingress.sh before updating; live service left unchanged"
    );
  const plist = "/Library/LaunchDaemons/com.nexalance.omniroute-native-ingress.plist";
  const args = JSON.parse(
    execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" })
  ).ProgramArguments;
  if (
    !Array.isArray(args) ||
    args.length !== 7 ||
    args[0] !== "/usr/bin/perl" ||
    !path.isAbsolute(args[1]) ||
    path.basename(args[1]) !== "omni-bind.pl" ||
    args[3] !== "127.0.0.1:443,[::1]:443" ||
    args[4] !== "--" ||
    args[5] !== "/usr/local/bin/node" ||
    args[6] !== installed ||
    !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(args[2])
  )
    throw new Error(
      "Native ingress must use Local-user-owned inherited sockets before updating; live service left unchanged"
    );
  const binder = fs.lstatSync(args[1]);
  const daemon = fs.lstatSync(plist);
  if (
    !binder.isFile() ||
    binder.uid !== 0 ||
    (binder.mode & 0o022) !== 0 ||
    !daemon.isFile() ||
    daemon.uid !== 0 ||
    (daemon.mode & 0o022) !== 0 ||
    Number(execFileSync("/usr/bin/id", ["-u", args[2]], { encoding: "utf8" }).trim()) === 0
  )
    throw new Error("Unsafe native ingress socket ownership or daemon permissions");
  return { ok: true, nativeIngressScoped: true, rootOwned: true };
}

export async function verifyClientDns(resolve = lookup) {
  const addresses = await resolve("api.anthropic.com", { all: true });
  if (!addresses.length || addresses.some(({ address }) => !["127.0.0.1", "::1"].includes(address)))
    throw new Error(
      "Native client DNS bypasses Agent Bridge despite hosts entries; refresh macOS DNS cache and reopen existing native sessions before retrying"
    );
  return { clientDnsVerified: true };
}

export async function verifyClientRouting(dataDir = path.join(os.homedir(), ".omniroute-local")) {
  const intent = JSON.parse(
    fs.readFileSync(path.join(dataDir, "mitm/runtime-intent.json"), "utf8")
  );
  return intent.enabled
    ? { ok: true, ...(await verifyClientDns()) }
    : { ok: true, bridgeEnabled: false };
}

export async function verifyLive(dataDir = path.join(os.homedir(), ".omniroute-local")) {
  const nativeIngress = verifyNativeIngress();
  const dir = path.join(dataDir, "mitm");
  const intent = JSON.parse(fs.readFileSync(path.join(dir, "runtime-intent.json"), "utf8"));
  if (!intent.enabled) return { ...nativeIngress, bridgeEnabled: false };
  const clientDns = await verifyClientDns();
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
    ...clientDns,
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
          : mode === "routing"
            ? await verifyClientRouting(process.argv[3])
            : mode === "live"
              ? await verifyLive(process.argv[3])
              : (() => {
                  throw new Error(
                    "usage: bridge-gate.mjs package <tgz> | ingress | routing [dataDir] | live [dataDir]"
                  );
                })();
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
