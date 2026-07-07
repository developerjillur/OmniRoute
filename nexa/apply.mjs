#!/usr/bin/env node
// nexa/apply.mjs — apply the overlay onto the pristine base (in place).
//   node nexa/apply.mjs            apply patches + copy new files (tree becomes APPLIED; run restore after)
//   node nexa/apply.mjs --check    dry-run: verify every patch still applies onto the current base
import { applyOverlay, checkPatches, listPatches } from "./lib/overlay.mjs";

const check = process.argv.includes("--check");
if (check) {
  const { total, failed } = checkPatches();
  if (failed.length === 0) {
    console.log(`  ✓ all ${total} patches apply cleanly onto the pristine base`);
    process.exit(0);
  }
  console.error(
    `  ✗ ${failed.length}/${total} patch(es) do NOT apply — re-cut these against the new upstream file:`
  );
  for (const f of failed)
    console.error(`    • ${f.patch}  →  ${f.target}\n      ${f.reason.split("\n")[0]}`);
  process.exit(1);
} else {
  if (listPatches().length === 0) console.log("  (no patches yet)");
  applyOverlay();
}
