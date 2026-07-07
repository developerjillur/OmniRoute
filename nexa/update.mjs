#!/usr/bin/env node
// nexa/update.mjs — pull an upstream update onto the pristine base, on demand.
// The merge is conflict-free by construction (our only additions live in nexa/, a path
// upstream never touches). The ONLY possible friction is a patch that no longer applies —
// reported here by exact file, then re-cut. No auto-sync CI; you run this when you want it.
import { execFileSync } from "node:child_process";
import { checkPatches, baseVersion, assertPristine, releaseStatus } from "./lib/overlay.mjs";

const run = (args) => execFileSync("git", args, { cwd: process.cwd(), stdio: "inherit" });
const useMain = process.argv.includes("--main"); // opt into bleeding-edge upstream/main

console.log("  → ensuring pristine base before update…");
assertPristine();

const before = baseVersion();
// Default: fetch RELEASE TAGS only (fast/incremental — a full-history fetch of `main` is slow and
// was timing out). `--main` additionally needs the branch ref.
console.log(useMain ? "  → fetching upstream (tags + main)…" : "  → fetching upstream release tags…");
run(useMain ? ["fetch", "upstream", "--tags"] : ["fetch", "upstream", "refs/tags/*:refs/tags/*"]);

// A production earning gateway tracks upstream RELEASE TAGS by default, never unreleased `main`.
let target;
if (useMain) {
  console.log("  ⚠ --main: targeting bleeding-edge upstream/main (UNRELEASED). Prefer a release tag.");
  target = "upstream/main";
} else {
  const rel = releaseStatus();
  if (!rel.tag) {
    console.error("  ✗ no upstream release tags found (fetch may have failed). Re-run, or pass --main.");
    process.exit(3);
  }
  if (rel.onLatest) {
    console.log(`  ✓ already on the latest upstream release ${rel.tag} — nothing to pull.`);
    console.log("    (Re-run when upstream cuts the next release; merged upstream PRs arrive then.)");
    process.exit(0);
  }
  console.log(`  → target: upstream release ${rel.tag} (base is behind it)`);
  target = rel.tag;
}

console.log(`  → fast-forwarding upstream-main mirror to ${target}…`);
run(["checkout", "upstream-main"]);
run(["merge", "--ff-only", target]);

console.log("  → merging into nexalance (conflict-free by construction)…");
run(["checkout", "nexalance"]);
try {
  run(["merge", "--no-edit", "upstream-main"]);
} catch {
  console.error(
    "\n  ✗ UNEXPECTED merge conflict. This should be impossible under the overlay model —"
  );
  console.error(
    "    it means an upstream file was edited directly on nexalance (guard was bypassed)."
  );
  console.error(
    "    Abort with `git merge --abort`, find the offender via `node nexa/check/pristine-base.mjs`,"
  );
  console.error("    move its edit into nexa/patches/, then re-run.\n");
  process.exit(2);
}

const after = baseVersion();
console.log(`\n  base: v${before.version} @ ${before.sha}  →  v${after.version} @ ${after.sha}`);

console.log("  → checking patch health against the new base…");
const { total, failed } = checkPatches();
if (failed.length === 0) {
  console.log(`  ✓ all ${total} patches still apply cleanly.`);
} else {
  console.log(
    `  ⚠ ${failed.length}/${total} patch(es) need a re-cut against the new upstream file(s):`
  );
  for (const f of failed) console.log(`      • ${f.patch} → ${f.target}`);
  console.log(
    `\n    Re-cut recipe (per failing patch): apply your intent onto the new pristine file, then`
  );
  console.log(
    `    \`git diff upstream-main -- <file> > nexa/patches/<slug>.patch\`. See nexa/skill/nexa-overlay.`
  );
}
console.log(
  `\n  Next: validate + deploy →  node nexa/build.mjs  (then the gate + launchd flip; see the skill).`
);
