# `nexa/` — NexaLance OmniRoute child-theme overlay

This fork of `diegosouzapw/OmniRoute` keeps the **upstream base byte-for-byte pristine** and puts
**every** NexaLance customization in this one folder — the WordPress "child theme" model for a
Node app. Upstream updates apply with **no merge conflicts** (by construction), and there is **no
auto-sync CI**; you pull updates on demand.

## Why merges never conflict

`nexalance` = the pristine upstream tree **+ this `nexa/` folder**, nothing else. No upstream file is
ever edited on the branch. Our source edits live as surgical patches here and are applied onto the
pristine base **at build time only**. Because our additions live in a path (`nexa/`) upstream never
touches, `git merge upstream/main` is always conflict-free. The only possible friction is a single
patch that no longer applies after upstream rewrites that exact region — reported by file, re-cut in
~20 seconds, and driven toward zero over time (Phase 2).

## Layout

| Path               | What                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `patches/`         | surgical unified diffs vs pristine upstream (one per file), applied with `git apply --3way`   |
| `new/`             | net-new files, mirrored to their real repo paths; copied into place at build                  |
| `config/`          | env / `next.config` params (Phase-2 promotion target)                                         |
| `plugins/`         | OmniRoute-native plugins — rarely usable (API can't set headers/see streaming/combo); most stay patches |
| `skill/`, `agent/` | the `nexa-overlay` skill + `nexa-overlay-maintainer` agent (installed to `.claude/` by setup) |
| `lib/overlay.mjs`  | the engine (inventory, guard, apply/restore, patch-health)                                    |
| `manifest.json`    | registry of every item (layer, class, upstream target, PR status)                             |
| `docs/`            | durable references that must survive upstream updates — e.g. `CODEX-IMAGE-GENERATION.md` (the `codex/gpt-5.5` images endpoint + model matrix + post-update checklist) |

## Commands (run from repo root)

```bash
node nexa/status.mjs          # base version, pristine state, patch health, drift
node nexa/setup.mjs           # install skill+agent into local .claude/ (once per clone)
node nexa/apply.mjs --check   # verify every patch still applies onto the base (no mutation)
node nexa/build.mjs           # apply → npm run build → auto-restore (the deploy build)
node nexa/update.mjs          # on-demand: fetch upstream, ff base, merge (conflict-free), patch-health
node nexa/restore.mjs         # undo an apply (return to pristine)
node nexa/check/pristine-base.mjs   # the guard — fails if anything outside nexa/ drifts
node nexa/gen-manifest.mjs    # regenerate manifest.json from live contents
```

## Golden rules

1. **Never edit an upstream file on `nexalance`.** Put the edit in `patches/` (or `new/` for net-new).
   The guard (`check/pristine-base.mjs`) enforces this.
2. **Never commit from an APPLIED tree.** `build.mjs` auto-restores; if you ran `apply.mjs` by hand,
   run `restore.mjs` before committing.
3. **`npm run dev` is BANNED** (OOM). Deploy is the production standalone via `build.mjs` + launchd.

Full workflow, invariants, re-cut recipe, and the deploy/rollback runbook: the **`nexa-overlay`
skill** (`nexa/skill/nexa-overlay/`, auto-installed to `.claude/` by `setup.mjs`).
