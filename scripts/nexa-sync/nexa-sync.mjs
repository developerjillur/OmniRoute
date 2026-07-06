#!/usr/bin/env node
/**
 * NexaLance living-fork upstream-sync orchestrator.
 *
 * Detects upstream (diegosouzapw/OmniRoute) updates, merges them into an
 * ISOLATED git worktree (never disturbs your checkout), captures conflicts,
 * validates the merged tree against our customization regression tests, and
 * writes a report. NEVER auto-pushes and NEVER touches the upstream remote.
 *
 * Usage:
 *   node scripts/nexa-sync/nexa-sync.mjs --check     # just detect updates (exit 10 if behind)
 *   node scripts/nexa-sync/nexa-sync.mjs             # full sandbox merge + validate + report
 *   node scripts/nexa-sync/nexa-sync.mjs --keep      # keep the sandbox worktree for inspection
 *   node scripts/nexa-sync/nexa-sync.mjs --no-validate  # merge + conflict report only (skip tests)
 *
 * Exit codes: 0 up-to-date OR clean+validated · 10 updates available (--check) ·
 *             20 merge conflicts · 30 validation failed · 1 internal error.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, ".nexa", "config.json"), "utf8"));
const ARGS = new Set(process.argv.slice(2));
const CHECK_ONLY = ARGS.has("--check");
const KEEP = ARGS.has("--keep");
const SKIP_VALIDATE = ARGS.has("--no-validate");

const git = (args, opts = {}) =>
  execFileSync("git", args, { cwd: opts.cwd || ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitOk = (args, opts = {}) => {
  const r = spawnSync("git", args, { cwd: opts.cwd || ROOT, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || ""), code: r.status };
};
const log = (m) => process.stdout.write(`${m}\n`);

function shortSha(ref) {
  try {
    return git(["rev-parse", "--short", ref]);
  } catch {
    return "unknown";
  }
}

function main() {
  const { upstreamRemote, upstreamBranch, productionBranch, sandboxWorktreeDir, syncBranchPrefix } = CFG;
  const upstreamRef = `${upstreamRemote}/${upstreamBranch}`;

  log(`[nexa-sync] fetching ${upstreamRef} …`);
  const fetch = gitOk(["fetch", upstreamRemote, upstreamBranch]);
  if (!fetch.ok) {
    log(`[nexa-sync] fetch failed:\n${fetch.out}`);
    process.exit(1);
  }

  const upstreamSha = shortSha(upstreamRef);
  const prodSha = shortSha(productionBranch);
  // How many upstream commits are NOT yet in our production branch?
  const behind = Number(git(["rev-list", "--count", `${productionBranch}..${upstreamRef}`]) || "0");

  log(`[nexa-sync] production '${productionBranch}'=${prodSha}  upstream ${upstreamRef}=${upstreamSha}  (behind ${behind})`);

  if (behind === 0) {
    log("[nexa-sync] ✓ up to date with upstream — nothing to sync.");
    writeState({ status: "up-to-date", upstreamSha, prodSha, behind, conflicts: [], validated: null });
    process.exit(0);
  }
  if (CHECK_ONLY) {
    log(`[nexa-sync] ⇩ ${behind} upstream commit(s) available to sync.`);
    process.exit(10);
  }

  // ── Sandbox worktree (isolated; the main checkout is never touched) ──
  const wt = path.join(ROOT, sandboxWorktreeDir);
  const syncBranch = `${syncBranchPrefix}${upstreamSha}`;
  cleanupWorktree(wt, syncBranch);
  log(`[nexa-sync] creating sandbox worktree ${sandboxWorktreeDir} (branch ${syncBranch}) …`);
  const add = gitOk(["worktree", "add", "-f", "-b", syncBranch, wt, productionBranch]);
  if (!add.ok) {
    log(`[nexa-sync] worktree add failed:\n${add.out}`);
    process.exit(1);
  }

  let exitCode = 0;
  try {
    log(`[nexa-sync] merging ${upstreamRef} into the sandbox …`);
    const merge = gitOk(["merge", "--no-ff", "--no-edit", upstreamRef], { cwd: wt });
    const conflicts = git(["diff", "--name-only", "--diff-filter=U"], { cwd: wt })
      .split("\n")
      .filter(Boolean);

    if (conflicts.length > 0) {
      log(`[nexa-sync] ⚠ ${conflicts.length} conflicted file(s):`);
      conflicts.forEach((f) => log(`    ${f}`));
      gitOk(["merge", "--abort"], { cwd: wt });
      writeReport({ upstreamSha, prodSha, behind, conflicts, validated: null, merged: false });
      writeState({ status: "conflicts", upstreamSha, prodSha, behind, conflicts, validated: null });
      log(`[nexa-sync] ✗ conflicts — a human/PR is needed. Report: .nexa/reports/sync-${upstreamSha}.md`);
      exitCode = 20;
      return;
    }

    if (!merge.ok) {
      log(`[nexa-sync] merge failed (no conflicts reported):\n${merge.out}`);
      exitCode = 1;
      return;
    }
    log("[nexa-sync] ✓ merge is CLEAN (no conflicts).");

    let validated = null;
    if (!SKIP_VALIDATE) {
      validated = runValidation(wt);
    }

    const allGreen = validated == null || validated.every((v) => v.ok);
    writeReport({ upstreamSha, prodSha, behind, conflicts: [], validated, merged: true });
    writeState({ status: allGreen ? "clean-validated" : "validation-failed", upstreamSha, prodSha, behind, conflicts: [], validated });

    if (allGreen) {
      log(`[nexa-sync] ✅ clean merge + validation green. Sandbox branch '${syncBranch}' is ready to fast-forward '${productionBranch}'.`);
      log(`[nexa-sync]    To land it:  git checkout ${productionBranch} && git merge --ff-only ${syncBranch}`);
      exitCode = 0;
    } else {
      log(`[nexa-sync] ✗ merge clean but VALIDATION FAILED. Report: .nexa/reports/sync-${upstreamSha}.md`);
      exitCode = 30;
    }
  } finally {
    if (!KEEP && exitCode !== 30) cleanupWorktree(wt, syncBranch);
    else if (KEEP || exitCode === 30) log(`[nexa-sync] sandbox kept at ${sandboxWorktreeDir} (branch ${syncBranch}) for inspection.`);
    process.exit(exitCode);
  }
}

function runValidation(wt) {
  // Symlink node_modules so the sandbox can typecheck/test without a reinstall.
  const nm = path.join(wt, "node_modules");
  if (!fs.existsSync(nm)) {
    try {
      fs.symlinkSync(path.join(ROOT, "node_modules"), nm, "dir");
    } catch (e) {
      log(`[nexa-sync] (could not symlink node_modules: ${e.message} — validation may fail)`);
    }
  }
  const results = [];
  for (const step of CFG.validate) {
    log(`[nexa-sync] validate → ${step.name}`);
    const r = spawnSync("bash", ["-lc", step.cmd], { cwd: wt, encoding: "utf8" });
    const ok = r.status === 0;
    results.push({ name: step.name, ok, tail: ((r.stdout || "") + (r.stderr || "")).split("\n").slice(-8).join("\n") });
    log(`[nexa-sync]   ${ok ? "✓" : "✗"} ${step.name}`);
  }
  return results;
}

function cleanupWorktree(wt, branch) {
  if (fs.existsSync(wt)) gitOk(["worktree", "remove", "--force", wt]);
  gitOk(["branch", "-D", branch]);
  gitOk(["worktree", "prune"]);
}

function writeState(s) {
  const dir = path.join(ROOT, ".nexa");
  fs.writeFileSync(path.join(dir, "last-sync.json"), JSON.stringify({ ...s, at: new Date().toISOString() }, null, 2) + "\n");
}

function writeReport({ upstreamSha, prodSha, behind, conflicts, validated, merged }) {
  const dir = path.join(ROOT, ".nexa", "reports");
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    `# NexaLance upstream-sync report — upstream ${upstreamSha}`,
    ``,
    `- Production branch base: \`${prodSha}\``,
    `- Upstream commits behind: **${behind}**`,
    `- Merge: ${merged ? "**clean (no conflicts)**" : `**${conflicts.length} conflict(s)**`}`,
    ``,
  ];
  if (conflicts.length) {
    lines.push(`## Conflicted files (need resolution)`, ``, ...conflicts.map((f) => `- \`${f}\``), ``);
    lines.push(`These are files BOTH we and upstream changed. Each carries a \`// NEXA\`/\`// SECURITY_AUDIT\`/\`// QA\` tag — keep BOTH our tagged change and upstream's.`, ``);
  }
  if (validated) {
    lines.push(`## Validation (our customization gate)`, ``);
    for (const v of validated) lines.push(`- ${v.ok ? "✅" : "❌"} **${v.name}**${v.ok ? "" : `\n\n  \`\`\`\n${v.tail}\n\`\`\``}`);
    lines.push(``);
  }
  fs.writeFileSync(path.join(dir, `sync-${upstreamSha}.md`), lines.join("\n"));
}

try {
  main();
} catch (e) {
  log(`[nexa-sync] internal error: ${e.stack || e.message}`);
  process.exit(1);
}
