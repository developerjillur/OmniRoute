---
name: nexa-fork-sync
description: Use when working in the NexaLance OmniRoute fork (developerjillur/OmniRoute) and you need to pull upstream (diegosouzapw/OmniRoute) updates, check whether the fork is behind upstream, resolve an upstream-merge conflict, upgrade the OmniRoute version, contribute a fix upstream, or when the standalone won't boot / a customization regressed after a build. Symptoms include "sync upstream", "fork is behind", "merge the new version", "upgrade OmniRoute", conflicts in files tagged // NEXA / // SECURITY_AUDIT / // QA.
---

# NexaLance OmniRoute Living-Fork Sync

## Overview

This repo is a **living fork** of `diegosouzapw/OmniRoute`. Core principle: **merge upstream continuously, but VALIDATE every merge in an isolated sandbox BEFORE it lands, and NEVER touch the upstream remote.** Our customizations (security, perf, NexaConnect config — ~59 files, see `.nexa/customizations.json` for the live list) are committed on branch `nexalance` and the load-bearing ones are guarded by regression tests.

## Invariants — violate none of these

- **NEVER push to `upstream`.** Push only to `origin` (our fork). `upstream` is read-only.
- **NEVER `git reset --hard` / force-push `nexalance`.** Our customizations live only there.
- **NEVER land an upstream merge without the validation gate passing** (typecheck + our regression tests).
- **NEVER resolve a conflict by taking only one side.** Our edits are tagged `// NEXA` / `// SECURITY_AUDIT` / `// QA` — keep **BOTH** our tagged change AND upstream's.
- **NEVER run `npm run dev`** to verify — it OOMs. Always the standalone (`npm run build` → launchd on :28128).

## Git structure

- Remotes: `origin` → `git@github.com:developerjillur/OmniRoute.git` (SSH — push here) · `upstream` → `https://github.com/diegosouzapw/OmniRoute.git` (HTTPS, never push). Push auth is the SSH key (`ssh -T git@github.com` if a push fails); a transient "access rights" error usually clears on retry.
- Branches: `nexalance` = production (upstream + our customizations) · `upstream-main` = pristine mirror · `main` = base.
- Config + tooling: `.nexa/config.json`, `scripts/nexa-sync/`, `.nexa/customizations.json` (which files are ours + which to PR upstream).

## The workflow

```bash
npm run nexa:status        # where are we vs upstream? how many customizations?
npm run nexa:sync          # sandbox-merge upstream + validate → .nexa/reports/sync-<sha>.md
```

`nexa:sync` fetches upstream, merges into an **isolated git worktree** (`.nexa/.sandbox` — your checkout is untouched), captures conflicts, runs the validation gate, and reports. Exit `0`=clean+green, `20`=conflicts, `30`=validation failed. On exit `0` **and** `30` the sandbox worktree + branch `nexa/sync-<sha>` are KEPT (land it / inspect it); on exit `20` the merge is auto-aborted. Then (cross-references use step **names**, not numbers, so they survive re-formatting):

1. **Anchor rollbacks** → `git tag nexa-prelease-$(date +%Y%m%d-%H%M)` on `nexalance`, and (right before the rebuild in **Deploy**) `cp -R .build/next/standalone .build/next/standalone.bak` — the two rollbacks in **Deploy** need these.
2. **Get a validated sync branch** →
   - **Clean (exit 0):** the validated branch `nexa/sync-<sha>` already exists → go straight to **Land**.
   - **Conflicts (exit 20):** re-run the merge yourself: `git checkout -b nexa/sync-<sha> nexalance && git merge --no-edit upstream/main`, resolve each conflict **keeping both sides** (see Conflict rule), `git grep '^<<<<<<<'` (must be empty), `git add -A && git commit --no-edit`.
3. **Validate** → the canonical gate is **`.nexa/config.json → validate[]`** (run exactly those): `typecheck:core` + `check-tsc-ratchet.mjs --ratchet` + the regression tests (`tests/unit/security/*`, `provider-validation-ssrf-guard`, `combo-diagnostics-trace` — full invocation in reference.md §4). ALL must pass. For a big/major upstream bump, also `npm run test:unit` + `npm run lint`.
4. **Land** → `git checkout nexalance && git merge --ff-only nexa/sync-<sha>` (ff-only ⇒ production == the exact tree you validated).
5. **Housekeep** → `check-tsc-ratchet.mjs --update` (upstream's TS-error delta ≠ our regression, so re-baseline) + `gen-manifest.mjs`; update the mirror `git branch -f upstream-main upstream/main`; commit.
6. **Push** → `git push origin nexalance`.
7. **Deploy** → `npm install` (sync deps to the merged lockfile) → back up (**Anchor rollbacks**) → `npm run build`. **Smoke the built artifact OUT-OF-BAND FIRST** (throwaway port + data dir, live :28128 untouched): `PORT=28129 DATA_DIR=/tmp/omni-smoke node .build/next/standalone/dev/run-standalone.mjs` (the build relocates `scripts/dev/run-standalone.mjs` → `dev/run-standalone.mjs`) → check `/api/monitoring/health`, a `cx/gpt-5.5` completion, `x-omniroute-catalog-cache` + `x-omniroute-*` streaming headers, CORS fail-closed. **Only if the throwaway passes**, flip live: `launchctl kickstart -k gui/$(id -u)/com.nexalance.omniroute-test` → re-smoke :28128 → watch `/tmp/omniroute-28128.log` ~10 min (launchd KeepAlive can mask a crash loop). **Rollback:** fast = `rm -rf .build/next/standalone && mv .build/next/standalone.bak .build/next/standalone && launchctl kickstart -k …`; source = `git reset --hard nexa-prelease-<stamp>` → rebuild → kickstart.

The full runbook is `scripts/nexa-sync/README.md`; the strategy is `NEXA-OMNIROUTE-LIVING-FORK-STRATEGY.md` (also in seville/).

## Conflict rule (the one that matters)

Every edit we made to an upstream file is tagged and surgical. A conflict = both sides changed the same region. **Keep both.** Examples from the v3.8.45 sync:

- `earlyStreamKeepalive.ts`: ours preserved source `x-omniroute-*` headers; upstream added an `extraHeaders` option → keep our `keepaliveHeaders` AND apply `extraHeaders` on top.
- `antigravity.ts`: ours added a safety-category filter; upstream added an assistant-turn strip → keep **both** functions (verify both are still called).
- `package.json`: keep our added scripts/pins + take upstream's version bump/dep bumps. If upstream edits the _same line_ as one of our pins (e.g. both change `@types/bun`), take upstream's value and drop our pin unless our pin exists to fix a specific break — pins are a means, not the goal.
- `package-lock.json`: **never hand-merge it.** Resolve `package.json` first, then `git checkout --theirs package-lock.json && npm install` to regenerate a consistent lockfile.
  After resolving, confirm no `<<<<<<<`/`=======`/`>>>>>>>` markers remain and every kept function is still referenced (`git grep '^<<<<<<<'`).

## Critical gotchas (each caused a real failure — see reference.md)

- **Standalone won't boot / health returns `000` after a build.** `000` = curl got connection-refused ⇒ the server never bound. Read `/tmp/omniroute-28128.log` FIRST, then check these three (most-likely first), because they look identical from the outside:
  1. **A new build-time module wasn't synced (the v3.8.45 cause).** Any NEW `scripts/build/*.mjs` that `run-standalone.mjs` imports (e.g. `startupGuard.mjs`) MUST be added to the sync list in `scripts/build/assembleStandalone.mjs` (`dest: ["build", "..."]`), or boot throws `ERR_MODULE_NOT_FOUND`. Log shows the missing import. Recover a live box by hot-copying it into `.build/next/standalone/build/`, then fix `assembleStandalone.mjs` permanently.
  2. **Our own `startupGuard` (H2) deliberately refused.** It aborts boot (exit 1) on a public/non-loopback bind when `REQUIRE_API_KEY` is off OR `INITIAL_PASSWORD`/`DASHBOARD_PASSWORD` is `CHANGEME`. Log shows the guard's refusal reason — this is correct behavior, not a bug: fix the env (or set `OMNIROUTE_ALLOW_INSECURE_PUBLIC` for a knowingly-local test), don't disable the guard.
  3. **Stale/missing build-time `.env` COPY.** The standalone reads `.build/next/standalone/.env`, NOT the root `.env`. A missing/old copy → wrong secrets → guard-refusal or a crash. Re-copy it.
- **tsc-ratchet fails after an upstream merge:** upstream may add TS errors — that's THEIRS, not our regression. Re-baseline with `--update` after a validated land.
- **node_modules in the sandbox worktree:** the orchestrator symlinks it; a manual sandbox needs `ln -s ../../node_modules node_modules` before validating.

## Shrink the fork over time (upstream contribution)

`.nexa/customizations.json` marks generic fixes `class:"upstream-candidate"` (currently 49). PR the cleanest, genuinely-generic ones to `diegosouzapw/OmniRoute`; once merged upstream they arrive via the next sync and leave our maintenance set forever. **Do NOT fire one PR per candidate** — many are coupled or NexaConnect-flavored; send a few themed, self-contained PRs, each cut from **pristine `upstream-main`** (never `nexalance`, which carries our other changes):

```bash
git worktree add -b upstream-pr/<slug> /tmp/omni-pr upstream-main    # pristine base
git -C /tmp/omni-pr checkout nexalance -- <only-this-fix's-files>    # our version of just those files (stages them)
git -C /tmp/omni-pr diff --cached --stat                            # MUST equal exactly the fix, nothing else
ln -s "$PWD/node_modules" /tmp/omni-pr/node_modules                 # so tsx/tests resolve in the worktree
# add a FOCUSED test → tests/unit/<name>.test.ts (node:test; import the module by RELATIVE path so the
# repo test:unit glob picks it up), then run just it to confirm GREEN:
#   node --import tsx --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts \
#     --test --test-force-exit tests/unit/<name>.test.ts
git -C /tmp/omni-pr add -A && git -C /tmp/omni-pr commit -m "fix(scope): …"
git -C /tmp/omni-pr push -u origin upstream-pr/<slug>               # push to OUR fork (origin)
gh pr create --repo diegosouzapw/OmniRoute --base main \
  --head developerjillur:upstream-pr/<slug> --title "…" --body "…"  # gh is authed (repo scope, SSH)
git worktree remove --force /tmp/omni-pr                            # branch stays on origin as the PR head
```

Why `checkout nexalance -- <file>` yields exactly the fix: our version of an **unconflicted** file = upstream v3.8.45 + only our edit (the v3.8.45 merge conflicted on just 4 files), so applying it onto `upstream-main` reproduces the fix alone — but always eyeball `diff --cached --stat` to be sure. **Proven end-to-end:** PRs #6451 (Set-Cookie redaction) + #6452 (Antigravity 403); full worked example in reference.md §8.

## Fork CI (already configured — don't redo)

- **Default branch = `nexalance`** — required: GitHub only honors the workflow's `schedule` + `workflow_dispatch` from the default branch. (The fork forked upstream's `main`; we switched it.)
- Actions: **read/write** permissions + **"Allow GitHub Actions to create and approve pull requests"** = ON (so the workflow's `gh pr create`/`gh issue create` work).
- `.github/workflows/nexa-upstream-sync.yml` runs **daily 06:17 UTC** + on demand (`gh workflow run nexa-upstream-sync.yml`, or the Actions tab). It opens a green PR on a `clean-validated` sync or an issue on conflicts/validation-fail — gated on the orchestrator's `.nexa/last-sync.json` **status**, not the exit code, so an up-to-date run cleanly no-ops.

## Deep reference

For the full customization inventory, the exact commands used in the v3.8.45 sync, the CI workflow, and the failure post-mortems: **read `reference.md` in this skill directory.**
