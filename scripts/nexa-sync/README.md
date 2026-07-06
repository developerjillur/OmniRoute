# NexaLance living-fork sync — runbook

Keeps our fork (`origin` = developerjillur/OmniRoute, branch `nexalance`) continuously
in sync with `upstream` (diegosouzapw/OmniRoute) **without losing customizations or
fighting merges**. Strategy: `seville/NEXA-OMNIROUTE-LIVING-FORK-STRATEGY.md`.

## One-time layout
- `origin` → our fork (push here) · `upstream` → diegosouzapw/OmniRoute (never push).
- `nexalance` → production = upstream + our customizations.
- `upstream-main` → pristine mirror of upstream. `.nexa/config.json` → remotes + validation gate.

## Everyday commands
```bash
npm run nexa:status        # where are we vs upstream? how many customizations?
npm run nexa:sync:check    # exit 10 if upstream has updates (for cron)
npm run nexa:sync          # sandbox-merge upstream + validate against our tests → report
```

## The flow (what the CI does automatically, daily)
1. **`npm run nexa:sync`** — fetches upstream, merges into an ISOLATED worktree
   (`.nexa/.sandbox`; your checkout is untouched), captures conflicts, runs the
   validation gate (`typecheck:core` + `tsc-ratchet` + our regression tests),
   writes `.nexa/reports/sync-<sha>.md`. Exit `0`=clean+green, `20`=conflicts, `30`=validation failed.
2. **If conflicts** — resolve them (every one of our edits is tagged `// NEXA` /
   `// SECURITY_AUDIT` / `// QA`, so **keep BOTH our tagged change and upstream's**),
   then continue the merge. The v3.8.45 sync needed only 3 files.
3. **If clean + green** — land it:
   ```bash
   git checkout nexalance && git merge --ff-only nexa/sync-<sha>
   node scripts/check/check-tsc-ratchet.mjs --update   # re-baseline (upstream's error delta ≠ our regression)
   node scripts/nexa-sync/gen-manifest.mjs             # refresh the registry
   git add -A && git commit && git push origin nexalance
   ```
4. **Deploy** — `npm install` (sync deps) → `npm run build` → restart the standalone.

## CI
`.github/workflows/nexa-upstream-sync.yml` runs the flow daily and opens a **green
auto-mergeable PR** (clean+validated) or an **issue with the report** (needs a human).
Enable it in the fork's Settings → Actions.

## Shrink the fork over time
`.nexa/customizations.json` marks generic fixes as `upstream-candidate` — open PRs for
those to `diegosouzapw/OmniRoute`; once merged upstream they leave our maintenance set.
