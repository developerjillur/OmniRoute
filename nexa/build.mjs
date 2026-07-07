#!/usr/bin/env node
// nexa/build.mjs — the deploy build entrypoint.
// apply overlay → `npm run build` → ALWAYS restore to pristine (finally), so the working
// tree is pristine before and after while the build output carries our customizations.
// Build runs in the repo root (unchanged from upstream), so the launchd path is untouched.
import { execFileSync } from "node:child_process";
import { applyOverlay, restore, REPO } from "./lib/overlay.mjs";

const buildCmd = process.argv.slice(2).length ? process.argv.slice(2) : ["run", "build"];
console.log("  → applying overlay…");
applyOverlay({ quiet: true });
let code = 0;
try {
  console.log(`  → npm ${buildCmd.join(" ")}  (in ${REPO})`);
  execFileSync("npm", buildCmd, { cwd: REPO, stdio: "inherit" });
  console.log("  ✓ build complete");
} catch (e) {
  code = e.status || 1;
  console.error("  ✗ build failed");
} finally {
  console.log("  → restoring pristine base…");
  restore({ quiet: true });
  console.log("  ✓ tree restored to pristine");
}
process.exit(code);
