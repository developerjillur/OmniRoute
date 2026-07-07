#!/usr/bin/env node
// nexa/check/pristine-base.mjs — the guard. Fails (exit 1) if anything outside nexa/ drifts
// from upstream-main. Wire into pre-commit / the validation gate so it is structurally
// impossible to reintroduce the old "edit-inside-an-upstream-file" pattern by accident.
import { checkPristine, isApplied } from "../lib/overlay.mjs";

if (isApplied()) {
  console.error(
    "  ✗ tree is in APPLIED state — run `node nexa/restore.mjs` before checking pristine."
  );
  process.exit(1);
}
const { pristine, offenders } = checkPristine();
if (pristine) {
  console.log("  ✓ pristine: everything outside nexa/ matches upstream-main");
  process.exit(0);
}
console.error("  ✗ NOT pristine — these files outside nexa/ differ from upstream-main:");
for (const o of offenders) console.error(`    • ${o}`);
console.error(
  "\n  Move each edit into nexa/patches/ (git diff upstream-main -- <file> > nexa/patches/<slug>.patch,"
);
console.error("  then git checkout upstream-main -- <file>) or nexa/new/ for net-new files.");
process.exit(1);
