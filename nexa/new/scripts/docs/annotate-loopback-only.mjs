#!/usr/bin/env node
// scripts/docs/annotate-loopback-only.mjs
// Adds `x-loopback-only: true` to every method of every docs/openapi.yaml path
// that falls under LOCAL_ONLY_API_PREFIXES (src/server/authz/routeGuard.ts — the
// single source of truth the security-tier check reads). This closes the
// documentation drift the security-tier check warns about: external API
// consumers now have an explicit signal that these routes are loopback-only
// (runtime enforcement already exists in routeGuard.ts; this is the docs half).
//
// Line-based on purpose: preserves every comment / quote-style / key-order in the
// hand-maintained spec (js-yaml round-tripping would drop comments). Idempotent.
// Scoped to the `paths:` block so a schema property never gets annotated.
// After running, regenerate the client module: node scripts/docs/gen-openapi-module.mjs
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OPENAPI_PATH = path.join(ROOT, "docs", "openapi.yaml");
const GUARD_PATH = path.join(ROOT, "src", "server", "authz", "routeGuard.ts");

const guardSrc = fs.readFileSync(GUARD_PATH, "utf-8");
// Capture the WHOLE array body up to `\n];` (the array has inline `//` comments,
// some containing `]` brackets and quoted words, so a `[^\]]+` capture truncates
// and a comma-split pollutes entries). Then extract only the quoted path strings.
const m = guardSrc.match(/export const LOCAL_ONLY_API_PREFIXES[^=]*=\s*\[([\s\S]*?)\n\];/);
const body = m ? m[1] : "";
const PREFIXES = [...body.matchAll(/["']([^"']+)["']/g)]
  .map((mm) => mm[1])
  .filter((s) => s.startsWith("/")) // drop comment-embedded quotes like "which"/"cursor"
  .map((p) => (p.endsWith("/") ? p.slice(0, -1) : p));

if (PREFIXES.length === 0) {
  console.error("Could not parse LOCAL_ONLY_API_PREFIXES from routeGuard.ts — aborting.");
  process.exit(1);
}

const lines = fs.readFileSync(OPENAPI_PATH, "utf-8").split("\n");
const out = [];
const PATH_RE = /^ {2}(\/\S+):\s*$/;
const METHOD_RE = /^ {4}(get|post|put|patch|delete):\s*$/;

let inPaths = false;
let currentPathIsLocal = false;
let added = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // Track the top-level `paths:` block so we never touch `components:`/schemas.
  // Only a real top-level KEY (starts with a letter) ends the block — column-0
  // comments (`# ...`) inside paths must NOT end it.
  if (/^paths:\s*$/.test(line)) inPaths = true;
  else if (/^[A-Za-z]/.test(line)) inPaths = false;

  if (inPaths) {
    const pathMatch = line.match(PATH_RE);
    if (pathMatch) {
      const p = pathMatch[1];
      currentPathIsLocal = PREFIXES.some((pre) => p === pre || p.startsWith(pre + "/"));
    }
  }

  out.push(line);

  if (inPaths && currentPathIsLocal && METHOD_RE.test(line)) {
    const next = lines[i + 1] || "";
    if (!/^ {6}x-loopback-only:\s*true\s*$/.test(next)) {
      out.push("      x-loopback-only: true");
      added++;
    }
  }
}

fs.writeFileSync(OPENAPI_PATH, out.join("\n"));
console.log(`annotated ${added} method(s) with x-loopback-only: true across ${PREFIXES.length} LOCAL_ONLY prefixes`);
