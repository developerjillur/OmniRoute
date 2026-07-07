#!/usr/bin/env node
// nexa/setup.mjs — install the overlay's skill + agent into the local (gitignored) .claude/
// so Claude Code auto-discovers them. Source of truth stays in nexa/ (tracked, one folder);
// .claude/ stays pristine-ignored. Run once per fresh clone; idempotent.
import fs from "node:fs";
import path from "node:path";
import { REPO, NEXA } from "./lib/overlay.mjs";

const copies = [
  {
    from: path.join(NEXA, "skill", "nexa-overlay"),
    to: path.join(REPO, ".claude", "skills", "nexa-overlay"),
  },
  {
    from: path.join(NEXA, "agent", "nexa-overlay-maintainer.md"),
    to: path.join(REPO, ".claude", "agents", "nexa-overlay-maintainer.md"),
  },
];

for (const { from, to } of copies) {
  if (!fs.existsSync(from)) {
    console.error(`  ⚠ missing source: ${path.relative(REPO, from)} — skipped`);
    continue;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  console.log(`  ✓ installed ${path.relative(REPO, to)}`);
}
console.log(
  "  Done. Claude Code will discover the nexa-overlay skill + maintainer agent in this repo."
);
