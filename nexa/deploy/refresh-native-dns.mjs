import fs from "node:fs";
import path from "node:path";
import { lookup } from "node:dns/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { verifyClientDns } from "./bridge-gate.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function hasNativeHostsEntries(text) {
  return (
    /^\s*127\.0\.0\.1\s+api\.anthropic\.com(?:\s|$)/m.test(text) &&
    /^\s*::1\s+api\.anthropic\.com(?:\s|$)/m.test(text)
  );
}

export function signalUnchangedFileWrite(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) throw Error("Expected a nonempty regular hosts file");
    const before = fs.readFileSync(filename);
    // A WRITE event is required by the hosts watcher; timestamp-only changes can be ignored.
    fs.writeSync(fd, before.subarray(0, 1), 0, 1, 0);
    fs.fsyncSync(fd);
    if (hash(fs.readFileSync(filename)) !== hash(before))
      throw Error(
        "Hosts content changed concurrently; do not overwrite another application's changes"
      );
    return hash(before);
  } finally {
    fs.closeSync(fd);
  }
}

async function waitForClientDns() {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await verifyClientDns(lookup);
    } catch {
      /* Wait for resolver reload. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

export function nativeHostsRoutingEnabled(text) {
  if (hasNativeHostsEntries(text)) return true;
  const active = text
    .split(/\r?\n/)
    .some((line) => line.split("#")[0].trim().split(/\s+/).slice(1).includes("api.anthropic.com"));
  if (active) throw Error("Incomplete native hosts routing; repair will not change entries");
  return false;
}

export async function refreshNativeDns({ allowDisabled = false } = {}) {
  if (process.platform !== "darwin" || process.getuid?.() !== 0)
    throw Error("Run this macOS DNS repair with sudo; enter the password in Terminal only");
  if (process.env.NODE_OPTIONS)
    throw Error("Run without NODE_OPTIONS so the real native client resolver is verified");
  const hosts = "/etc/hosts";
  const stat = fs.lstatSync(hosts);
  if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022)
    throw Error("Unsafe hosts file ownership, permissions or symlink");
  const bytes = fs.readFileSync(hosts);
  if (!nativeHostsRoutingEnabled(bytes.toString("utf8"))) {
    if (allowDisabled) return { ok: true, bridgeEnabled: false, changed: false };
    throw Error(
      "Enable Claude Code DNS in Agent Bridge first; repair will not add or remove entries"
    );
  }
  try {
    return { ok: true, changed: false, ...(await verifyClientDns()) };
  } catch {
    /* Repair confirmed mismatch. */
  }
  const backups = "/Library/Application Support/OmniRoute-Native-Ingress/dns-backups";
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  const backupDir = fs.lstatSync(backups);
  if (!backupDir.isDirectory() || backupDir.uid !== 0 || backupDir.mode & 0o022)
    throw Error("Unsafe DNS backup directory");
  const backup = path.join(backups, `${Date.now()}-${randomUUID()}.hosts`);
  fs.writeFileSync(backup, bytes, { flag: "wx", mode: 0o600 });
  const hostsSha256 = signalUnchangedFileWrite(hosts);
  execFileSync("/usr/bin/dscacheutil", ["-flushcache"], { timeout: 5000 });
  execFileSync("/usr/bin/killall", ["-HUP", "mDNSResponder"], { timeout: 5000 });
  let verified = await waitForClientDns();
  let resolverRestarted = false;
  if (!verified) {
    // Normal termination lets launchd restart its existing resolver; no service is disabled.
    execFileSync("/usr/bin/killall", ["mDNSResponder"], { timeout: 5000 });
    resolverRestarted = true;
    verified = await waitForClientDns();
  }
  if (!verified)
    throw Error(
      "Client DNS still bypasses Bridge after hosts reload and resolver restart; live ingress was not changed"
    );
  return {
    ok: true,
    ...verified,
    hostsContentPreserved: true,
    hostsSha256,
    backup,
    resolverRestarted,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = ["--repair", "--repair-if-enabled"].includes(process.argv[2])
      ? await refreshNativeDns({ allowDisabled: process.argv[2] === "--repair-if-enabled" })
      : await verifyClientDns();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
