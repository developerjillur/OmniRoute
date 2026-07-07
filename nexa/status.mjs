#!/usr/bin/env node
// nexa/status.mjs — where are we? base version, pristine state, patch health, drift.
import {
  baseVersion,
  checkPristine,
  checkPatches,
  listPatches,
  listNewFiles,
  isApplied,
  git,
} from "./lib/overlay.mjs";

const { sha, version } = baseVersion();
console.log(`\n  NexaLance OmniRoute overlay — status`);
console.log(`  ─────────────────────────────────────`);
console.log(`  base (upstream-main): v${version} @ ${sha}`);

// how far behind upstream (only if we have a local upstream/main ref; no network)
const behind = git(["rev-list", "--count", "upstream-main..upstream/main"], { allowFail: true });
if (behind && behind !== "0")
  console.log(`  upstream/main is ${behind} commit(s) AHEAD — run \`node nexa/update.mjs\``);
else if (behind === "0") console.log(`  up to date with local upstream/main (fetch to be sure)`);

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
console.log("");
