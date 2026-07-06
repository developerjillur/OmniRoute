#!/usr/bin/env node
/**
 * Generate .nexa/customizations.json — the registry of every file our fork
 * changes vs the upstream base, classified so we know which to CONTRIBUTE
 * upstream (shrinks the fork) vs KEEP forever (NexaConnect-specific). Run after
 * landing changes: `node scripts/nexa-sync/gen-manifest.mjs`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const git = (a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();

const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, ".nexa", "config.json"), "utf8"));
const PROD = CFG.productionBranch;
const UPSTREAM = `${CFG.upstreamRemote}/${CFG.upstreamBranch}`;

// Files that are OURS forever (never contribute upstream).
const NEXA_SPECIFIC = [
  /^\.nexa\//,
  /^\.github\/workflows\/nexa-/,
  /^scripts\/nexa-sync\//,
  /^scripts\/check\/check-tsc-ratchet\.mjs$/,
  /^scripts\/build\/startupGuard\.mjs$/, // our bind guard (could be offered upstream too)
  /^config\/quality\/tsc-error-baseline\.json$/,
  /^docker-compose\.nexaconnect\.yml$/,
];

const base = git(["merge-base", PROD, UPSTREAM]);
const files = git(["diff", "--name-only", `${base}..${PROD}`]).split("\n").filter(Boolean);

const entries = files.map((file) => {
  const nexa = NEXA_SPECIFIC.some((re) => re.test(file));
  const isNew = git(["ls-tree", base, "--", file]) === ""; // absent in base = overlay (zero-conflict)
  return {
    file,
    class: nexa ? "nexa-specific" : "upstream-candidate",
    kind: isNew ? "overlay-new" : "modified-upstream",
    conflictRisk: isNew ? "none" : "on-overlap",
  };
});

const manifest = {
  _comment:
    "NexaLance fork customization registry. 'upstream-candidate' files are generic fixes worth PRing to diegosouzapw/OmniRoute (shrinks the fork); 'nexa-specific' stay forever. 'overlay-new' files have ZERO merge-conflict risk.",
  upstreamBase: base.slice(0, 12),
  productionBranch: PROD,
  counts: {
    total: entries.length,
    modifiedUpstream: entries.filter((e) => e.kind === "modified-upstream").length,
    overlayNew: entries.filter((e) => e.kind === "overlay-new").length,
    upstreamCandidates: entries.filter((e) => e.class === "upstream-candidate").length,
    nexaSpecific: entries.filter((e) => e.class === "nexa-specific").length,
  },
  files: entries.sort((a, b) => a.file.localeCompare(b.file)),
};

fs.writeFileSync(path.join(ROOT, ".nexa", "customizations.json"), JSON.stringify(manifest, null, 2) + "\n");
process.stdout.write(
  `[gen-manifest] ${manifest.counts.total} files — ${manifest.counts.overlayNew} overlays (0 conflict), ` +
    `${manifest.counts.modifiedUpstream} modified; ${manifest.counts.upstreamCandidates} upstream-candidates, ` +
    `${manifest.counts.nexaSpecific} nexa-specific → .nexa/customizations.json\n`
);
