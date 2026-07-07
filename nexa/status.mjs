#!/usr/bin/env node
// nexa/status.mjs — where are we? base version, pristine state, patch health, drift.
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  baseVersion,
  checkPristine,
  checkPatches,
  listPatches,
  listNewFiles,
  isApplied,
  releaseStatus,
  NEXA,
} from "./lib/overlay.mjs";

const { sha, version } = baseVersion();
console.log(`\n  NexaLance OmniRoute overlay — status`);
console.log(`  ─────────────────────────────────────`);
console.log(`  base (upstream-main): v${version} @ ${sha}`);

// release tracking: are we on the newest upstream RELEASE tag? (uses local tags; no network)
const rel = releaseStatus();
if (rel.tag && rel.onLatest) console.log(`  release: ✓ on the latest upstream release ${rel.tag}`);
else if (rel.tag)
  console.log(`  release: ⚠ ${rel.tag} available (base is behind) — run \`node nexa/update.mjs\``);
else console.log(`  release: (no release tags fetched yet — run \`node nexa/update.mjs\`)`);

console.log(`  overlay: ${listPatches().length} patches · ${listNewFiles().length} new files`);

if (isApplied()) {
  console.log(`  state:   ⚠ APPLIED (run \`node nexa/restore.mjs\`)`);
} else {
  const { pristine, offenders } = checkPristine();
  console.log(
    `  state:   ${pristine ? "✓ pristine base + nexa/ overlay" : "✗ NOT pristine: " + offenders.slice(0, 5).join(", ")}`
  );
}

const { total, failed } = checkPatches();
if (failed.length === 0) console.log(`  patches: ✓ all ${total} apply cleanly`);
else {
  console.log(`  patches: ✗ ${failed.length}/${total} need a re-cut:`);
  for (const f of failed) console.log(`             • ${f.patch} → ${f.target}`);
}

try {
  const mf = JSON.parse(readFileSync(path.join(NEXA, "manifest.json"), "utf8"));
  const m = mf.counts?.mergedUpstreamPR || 0,
    p = mf.counts?.pendingUpstreamPR || 0;
  if (m || p)
    console.log(
      `  upstream: ${m} merged (delete on next release) · ${p} pending PR — overlay self-shrinks`
    );
} catch {}
console.log("");
