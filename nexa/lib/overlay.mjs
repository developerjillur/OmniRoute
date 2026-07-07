// nexa/lib/overlay.mjs — core engine for the NexaLance OmniRoute child-theme overlay.
//
// Model (WordPress child-theme): the branch `nexalance` = a PRISTINE upstream tree
// (byte-for-byte identical to `upstream-main`) PLUS one top-level `nexa/` folder that
// holds every customization. Because our only additions live in `nexa/` (a path upstream
// never touches), `git merge upstream/main` is conflict-free by construction. Our source
// edits live as surgical patches (`nexa/patches/`) applied onto the pristine base at build
// time; our net-new files live in `nexa/new/` and are copied into place at build time.
//
// This module is dependency-free Node ESM. It never mutates git history; it only reads,
// applies patches to the working tree, and restores.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASE_REF = "upstream-main";
export const NEXA = path.join(REPO, "nexa");
export const PATCH_DIR = path.join(NEXA, "patches");
export const NEW_DIR = path.join(NEXA, "new");
export const WORK_DIR = path.join(NEXA, ".work");
export const APPLIED_MARKER = path.join(WORK_DIR, "applied.json");

export function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(" ")} failed:\n${e.stderr || e.message}`);
  }
}

// ---- inventory -------------------------------------------------------------

export function listPatches() {
  if (!fs.existsSync(PATCH_DIR)) return [];
  return fs
    .readdirSync(PATCH_DIR)
    .filter((f) => f.endsWith(".patch"))
    .sort()
    .map((f) => path.join(PATCH_DIR, f));
}

// The reliable target path of a patch = its `+++ b/<path>` line (slug reversal is unsafe
// for paths containing `__`, e.g. `__tests__`).
export function patchTarget(patchPath) {
  const txt = fs.readFileSync(patchPath, "utf8");
  const m = txt.match(/^\+\+\+ b\/(.+)$/m);
  return m ? m[1].trim() : null;
}

export function listNewFiles() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push({ src: abs, dest: path.relative(NEW_DIR, abs) });
    }
  };
  walk(NEW_DIR);
  return out.sort((a, b) => a.dest.localeCompare(b.dest));
}

// ---- pristine guard --------------------------------------------------------

// Everything OUTSIDE nexa/ must equal upstream-main, with no untracked strays.
export function checkPristine() {
  const changed = (git(["diff", "--name-only", BASE_REF, "--", ".", ":(exclude)nexa/"]) || "")
    .split("\n")
    .filter(Boolean);
  const untracked = (git(["ls-files", "--others", "--exclude-standard"]) || "")
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.startsWith("nexa/"));
  const offenders = [...changed, ...untracked.map((f) => `${f} (untracked)`)];
  return { pristine: offenders.length === 0, offenders };
}

export function assertPristine() {
  const r = checkPristine();
  if (!r.pristine) {
    throw new Error(
      "Base is NOT pristine (something outside nexa/ differs from upstream-main).\n" +
        "If the tree is in an APPLIED state, run `node nexa/restore.mjs` first.\n" +
        "Offenders:\n  " +
        r.offenders.join("\n  ")
    );
  }
}

// ---- patch health ----------------------------------------------------------

// Would every patch apply onto the current base? Uses --3way so minor upstream drift
// around a hunk auto-resolves; only a genuine overlap fails.
export function checkPatches() {
  const failed = [];
  for (const p of listPatches()) {
    const rel = path.basename(p);
    try {
      execFileSync("git", ["apply", "--check", "--3way", p], { cwd: REPO, stdio: "pipe" });
    } catch (e) {
      failed.push({
        patch: rel,
        target: patchTarget(p),
        reason: (e.stderr?.toString() || e.message).trim(),
      });
    }
  }
  return { total: listPatches().length, failed };
}

// ---- apply / restore -------------------------------------------------------

export function applyOverlay({ quiet = false } = {}) {
  assertPristine();
  const patched = [];
  const created = [];
  for (const p of listPatches()) {
    execFileSync("git", ["apply", "--3way", "--whitespace=nowarn", p], {
      cwd: REPO,
      stdio: "pipe",
    });
    const t = patchTarget(p);
    if (t) patched.push(t);
  }
  for (const { src, dest } of listNewFiles()) {
    const abs = path.join(REPO, dest);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(src, abs);
    created.push(dest);
  }
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.writeFileSync(
    APPLIED_MARKER,
    JSON.stringify({ at: new Date().toISOString(), patched, created }, null, 2)
  );
  if (!quiet) {
    console.log(
      `\n  ⚠  TREE IS IN APPLIED STATE — ${patched.length} patches + ${created.length} new files applied.`
    );
    console.log(
      `     Do NOT commit from here. Run \`node nexa/restore.mjs\` to return to pristine.\n`
    );
  }
  return { patched, created };
}

export function restore({ quiet = false } = {}) {
  let marker = null;
  if (fs.existsSync(APPLIED_MARKER)) marker = JSON.parse(fs.readFileSync(APPLIED_MARKER, "utf8"));
  const patched = marker?.patched ?? listPatches().map(patchTarget).filter(Boolean);
  const created = marker?.created ?? listNewFiles().map((n) => n.dest);
  // Restore from the pristine base REF (not the index) so it is correct regardless of
  // whether the migration is committed and independent of index state. `:(literal)` keeps
  // glob-magic paths (e.g. `[id]`) from being misinterpreted, without disabling other magic.
  if (patched.length) git(["checkout", BASE_REF, "--", ...patched.map((p) => `:(literal)${p}`)]);
  for (const dest of created) {
    const abs = path.join(REPO, dest);
    if (fs.existsSync(abs)) fs.rmSync(abs);
  }
  if (fs.existsSync(APPLIED_MARKER)) fs.rmSync(APPLIED_MARKER);
  if (!quiet)
    console.log(
      `  ✓ restored to pristine base (${patched.length} files, ${created.length} new removed)`
    );
}

export function isApplied() {
  return fs.existsSync(APPLIED_MARKER);
}

// ---- base version ----------------------------------------------------------

export function baseVersion() {
  const sha = git(["rev-parse", "--short", BASE_REF]);
  let version = "?";
  try {
    version = JSON.parse(git(["show", `${BASE_REF}:package.json`])).version || "?";
  } catch {}
  return { sha, version };
}
