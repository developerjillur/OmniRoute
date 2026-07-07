---
name: nexa-overlay
description: Use when working in the NexaLance OmniRoute fork (developerjillur/OmniRoute) — pulling upstream (diegosouzapw/OmniRoute) updates, adding or changing a NexaLance customization, re-cutting a patch that stopped applying, building/deploying the standalone, or when the pristine-base guard fails / a patch won't apply. This fork uses a WordPress-child-theme OVERLAY: the base stays byte-for-byte pristine and every customization lives in `nexa/`. Symptoms: "sync upstream", "update OmniRoute", "add a fix to the fork", "patch failed to apply", "base not pristine", "rebuild/deploy the gateway".
---

# NexaLance OmniRoute — Child-Theme Overlay

## Overview

This repo is a fork of `diegosouzapw/OmniRoute` run as a **child-theme overlay**. The branch
`nexalance` = the **pristine upstream tree, byte-for-byte** (identical to `upstream-main`) **plus one
top-level `nexa/` folder** holding every customization. Our source edits live as surgical patches
(`nexa/patches/`) applied onto the pristine base at build time; net-new files live in `nexa/new/`.

**Why merges never conflict:** our only additions live in `nexa/`, a path upstream never touches, so
`git merge upstream/main` is conflict-free by construction. The only possible friction is a single
patch that no longer applies after upstream rewrites that exact region — reported by file, re-cut in
minutes, shrunk toward zero over time (Phase 2). There is **no auto-sync CI**; you update on demand.

Read `nexa/README.md` for the layout. Deep reference (inventory, re-cut worked example, Phase-2
promotion, post-mortems): `reference.md` in this skill dir.

## Invariants — violate none

- **NEVER edit an upstream file on `nexalance`.** Put the change in `nexa/patches/` (edit) or
  `nexa/new/` (net-new). The guard `node nexa/check/pristine-base.mjs` enforces this.
- **NEVER commit from an APPLIED tree.** `node nexa/build.mjs` auto-restores; if you ran
  `node nexa/apply.mjs` by hand, run `node nexa/restore.mjs` before committing. (`nexa/status.mjs`
  shows the applied/pristine state.)
- **NEVER push to `upstream`.** Push only to `origin` (our fork). `upstream` is read-only.
- **NEVER deploy without the validation gate green** (typecheck + tsc-ratchet + regression tests),
  smoked **out-of-band first**.
- **`npm run dev` is BANNED** (15–25 s route compiles, ~1 GB OOM). Deploy = the production standalone
  via `nexa/build.mjs` + launchd.
- **Commit overlay changes with `git commit --no-verify`.** The husky pre-commit hook (lint-staged)
  runs prettier/eslint on staged files — including the pristine upstream files — and reformats them,
  silently breaking the byte-pristine base. `--no-verify` skips it. The guard catches it if you forget.

## Git structure

- Remotes: `origin` → `git@github.com:developerjillur/OmniRoute.git` (SSH, push here) · `upstream` →
  `https://github.com/diegosouzapw/OmniRoute.git` (never push).
- Branches: `nexalance` = production (pristine base + `nexa/`) · `upstream-main` = pristine mirror
  (only ff'd from a release tag / `upstream/main`, never hand-edited) · `pre-child-theme-migration` =
  pre-overlay rollback anchor.
- **No CI:** GitHub Actions is **DISABLED** on the fork (default branch `nexalance`). The child-theme
  model needs no workflows — validation is 100% local (`nexa/build.mjs` + gate + smoke). Upstream PRs
  via `gh` still work. Details + re-enable command: `reference.md` §2b.

## Workflow (run from repo root)

```bash
node nexa/status.mjs           # base version, pristine/applied state, patch health, drift
node nexa/setup.mjs            # install this skill + the maintainer agent into local .claude/ (per clone)
node nexa/apply.mjs --check    # verify every patch still applies onto the base (no mutation)
node nexa/build.mjs            # apply → npm run build → AUTO-RESTORE (the deploy build)
node nexa/update.mjs           # on-demand: pull the latest upstream RELEASE tag (conflict-free); --main = bleeding edge
node nexa/restore.mjs          # undo a manual apply (return to pristine)
node nexa/gen-manifest.mjs     # regenerate nexa/manifest.json from live contents
```

## Update upstream (the core loop)

1. `node nexa/update.mjs` — fetches upstream **release tags**, and if a newer release than our base
   exists, ff's `upstream-main` to that RELEASE TAG and merges into `nexalance` (conflict-free), then
   checks every patch. It tracks releases, NOT bleeding-edge `main` (a production earning gateway must
   not run unreleased code); pass `--main` only to deliberately target `upstream/main`. If already on the
   latest release it no-ops ("nothing to pull") — e.g. our merged upstream PRs arrive when upstream cuts
   the next release, and re-running then pulls them + flags the now-redundant patches for deletion.
2. **If it reports failing patches**, re-cut each (see next section). Re-run `node nexa/apply.mjs --check`
   until clean.
3. **Validate + deploy**: `node nexa/build.mjs` → run the gate → smoke out-of-band → flip launchd
   (see Deploy).
4. `node nexa/gen-manifest.mjs`, commit, `git push origin nexalance`.

## Re-cut a patch (the only reconciliation this model has)

When `update`/`apply --check` says `nexa/patches/<slug>.patch → <file>` fails, upstream changed that
file's patched region. Re-cut it against the NEW pristine file:

```bash
# 1. get the intent: read the current patch to see what our edit does
cat nexa/patches/<slug>.patch
# 2. apply your intent by hand onto the new pristine file (edit <file> directly), then:
git diff upstream-main -- <file> > nexa/patches/<slug>.patch   # regenerate the patch
git checkout upstream-main -- <file>                            # put the base file back to pristine
node nexa/apply.mjs --check                                     # confirm green
```

`git apply --3way` already auto-absorbs drift that is NOT in the patched region, so re-cuts are only
needed for genuine overlap. Prefer promoting the patch out of existence instead (Phase 2, below).

## Add / change a customization — the override ladder

Route each change to the CLEANEST layer it can occupy (never edit an upstream file in place):

1. **config/env** → `nexa/config/` (values, flags). Cheapest.
2. **native plugin** → `nexa/plugins/` — RARELY viable: the plugin API can't set response headers, can't
   see streaming/SSE, and can't see combo internals (verified 2026-07-07), so diagnostics/header/combo/
   idempotency edits do NOT fit here. Only for buffered request/response-BODY observation.
3. **PR upstream** → generic fixes go to `diegosouzapw/OmniRoute`; once merged, delete the patch.
4. **whole-module override** → own the file (rare).
5. **surgical patch** → `nexa/patches/` (last resort). To add: edit `<file>`, then
   `git diff upstream-main -- <file> > nexa/patches/<slug>.patch && git checkout upstream-main -- <file>`.

Net-new files: drop them in `nexa/new/<real/path>` (they are copied to `<real/path>` at build). Then
`node nexa/gen-manifest.mjs`.

## Deploy + rollback (production standalone only)

Anchor rollback first: `git tag nexa-prelease-$(date +%Y%m%d-%H%M) nexalance` and back up the built
standalone. Then:

```bash
node nexa/build.mjs            # apply → npm run build → auto-restore; output in .build/next/standalone
# smoke OUT-OF-BAND FIRST (live :28128 untouched) — MUST cd into the standalone dir (server.js resolves off CWD):
(cd .build/next/standalone && PORT=28129 DATA_DIR=/tmp/omni-smoke node dev/run-standalone.mjs)
#   check /api/monitoring/health, a cx/gpt-5.5 completion, x-omniroute-* streaming/catalog headers, CORS fail-closed
kill $(lsof -ti tcp:28129)     # kill by PORT, not PID
# CAVEAT: a 2nd instance binds FIXED aux ports 20129 (LiveWS) + 20131 (EmbedWsProxy) that PORT does NOT
#   remap, so while live :28128 is up the throwaway EADDRINUSE-crashes. Either stop live first, or (what
#   the 2026-07-07 deploy did) skip out-of-band and validate by kickstarting live directly with rollback
#   armed, then verify :28128 health + a real completion. The build is byte-identical source to live, so
#   `nexa/build.mjs` succeeding + a clean :28128 boot is sufficient proof.
# only if the throwaway passes (or per the caveat above), flip live:
launchctl kickstart -k gui/$(id -u)/com.nexalance.omniroute-test    # → re-smoke :28128, watch /tmp/omniroute-28128.log ~10 min
```

**Rollback:** fast = restore the standalone backup + `launchctl kickstart -k …`; source =
`git reset --hard nexa-prelease-<stamp>` → `node nexa/build.mjs` → kickstart.

## Validation gate

Runs against the APPLIED tree (in a sandbox or right after `apply`, before restore): `npm run
typecheck:core` · `node scripts/check/check-tsc-ratchet.mjs --ratchet` · the regression tests
(`tests/unit/security/*`, `provider-validation-ssrf-guard`, `combo-diagnostics-trace`,
`idempotency-fusion-collision`). Those test files + the ratchet script live in `nexa/new/` and land at
their real paths on apply. tsc-ratchet is down-only; an upstream error-count rise is theirs — hand-edit
`config/quality/tsc-error-baseline.json` (it applies from `nexa/new/`).

## Critical gotchas (each caused a real failure)

- **Overlay tooling pathspecs:** the engine passes literal file paths (one has glob-magic: `[id]`).
  Restore uses `:(literal)<path>`; do NOT set `GIT_LITERAL_PATHSPECS=1` globally — it disables the
  `:(exclude)nexa/` magic the guard needs. Restore is **ref-based** (`git checkout upstream-main -- …`),
  never index-based.
- **Standalone won't boot / health `000` after build:** read `/tmp/omniroute-28128.log` first. Usual
  causes: a NEW build-time module not synced in `assembleStandalone.mjs` (add a `dest` entry — it is a
  patch in `nexa/patches/`); the `startupGuard` deliberately refusing a public bind with weak env
  (correct — fix the env); a stale build-time `.env` copy. Full post-mortems in `reference.md`.
- **`npm run dev`** → OOM. Never.

## Phase 2 — shrink the overlay (self-cleaning, no rush)

Shrink via **upstream PRs** — the effective path. Each merged PR deletes a patch (the fix arrives via the
pristine base on the next `update`). The `upstream-candidate` patches → PRs to `diegosouzapw/OmniRoute`
(responsive; #6451 + #6452 merged, 8 open incl. #6545 combo-diagnostics). **Plugin conversion does NOT
work** for our patch types — verified 2026-07-07: the plugin API can't set response headers, can't see
streaming/SSE, can't see combo internals, and runs after the idempotency check, so
earlyStreamKeepalive / combo+error diagnostics / idempotency-fusion are NOT-CONVERTIBLE. Keep them as
surgical patches. `nexa/status.mjs` tracks the shrinking count; see `reference.md` §7.
