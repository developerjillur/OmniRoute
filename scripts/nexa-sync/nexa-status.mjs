#!/usr/bin/env node
/**
 * NexaLance fork status at a glance: our production version, upstream version,
 * how far behind we are, last sync result, and customization counts.
 *   node scripts/nexa-sync/nexa-status.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, ".nexa", "config.json"), "utf8"));
const git = (a) => {
  try {
    return execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const read = (p) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
  } catch {
    return null;
  }
};

const prod = CFG.productionBranch;
const up = `${CFG.upstreamRemote}/${CFG.upstreamBranch}`;
git(["fetch", CFG.upstreamRemote, CFG.upstreamBranch]); // refresh
const behind = git(["rev-list", "--count", `${prod}..${up}`]) || "0";
const ahead = git(["rev-list", "--count", `${up}..${prod}`]) || "0";
const ourVer = (read("package.json") || {}).version || "?";
const upVer = git(["show", `${up}:package.json`]).match(/"version":\s*"([^"]+)"/)?.[1] || "?";
const manifest = read(".nexa/customizations.json");
const lastSync = read(".nexa/last-sync.json");

const line = (k, v) => console.log(`  ${k.padEnd(22)} ${v}`);
console.log("\nNexaLance ⟷ OmniRoute — fork status\n");
line("production branch", `${prod} (v${ourVer})`);
line("upstream", `${up} (v${upVer})`);
line("behind upstream", behind === "0" ? "✓ up to date" : `⇩ ${behind} commit(s) — run: npm run nexa:sync`);
line("our customizations", `${ahead} commit(s) ahead`);
if (manifest) {
  line("customized files", `${manifest.counts.total} (${manifest.counts.overlayNew} overlays/0-conflict, ${manifest.counts.modifiedUpstream} modified)`);
  line("upstream-candidates", `${manifest.counts.upstreamCandidates} (PR these to shrink the fork)`);
  line("nexa-specific", `${manifest.counts.nexaSpecific}`);
}
if (lastSync) line("last sync", `${lastSync.status} ${lastSync.version ? "→ v" + lastSync.version : ""} @ ${lastSync.at || "?"}`);
console.log("");
