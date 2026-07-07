# nexa-overlay — deep reference

Everything a future session needs to run the OmniRoute child-theme overlay perfectly. Read `SKILL.md`
first for the workflow; this is the exhaustive backing.

## 1. Why the overlay exists

`OmniRoute` (`diegosouzapw/OmniRoute`) is the model gateway NexaConnect uses. We customize it
(security-audit fixes, QA remediation, perf, NexaConnect config). Working detached would miss every
upstream feature/fix; editing upstream files in place (the old "living-fork" model) meant a merge
conflict on almost every sync. The overlay fixes that at the root: **keep the base byte-for-byte
pristine, put every customization in `nexa/`, apply it at build time.** Merges become conflict-free by
construction; the only residual is a patch whose region upstream rewrote, re-cut in minutes.

## 2. Migration record (Phase 1, 2026-07-07)

Converted the living fork (60 tracked customizations: 40 modified-upstream + 20 new, plus fork tooling)
into the overlay:

- **43 modified-upstream files → per-file patches** in `nexa/patches/` (`git diff upstream-main -- <f>`),
  then each file reverted to pristine. 39 remain as patches; 4 went pristine instead: `package.json` +
  `package-lock.json` (dropped the `nexa:*` scripts — replaced by `node nexa/*.mjs` — and the
  `@types/bun` pin, a generic upstream-candidate), `.gitignore` (our additions were obsolete/redundant
  — upstream already ignores `.claude/**` and `_artifacts/`), `CLAUDE.md` (fork-doc, superseded by the
  skill + `nexa/README.md`).
- **14 product-new files → `nexa/new/`** (moved to their real paths mirrored under `nexa/new/`).
- **The old fork tooling was retired:** `.github/workflows/nexa-upstream-sync.yml` (daily auto-sync —
  dropped by request), `.nexa/{config,customizations}.json`, `scripts/nexa-sync/*`. The skill + agent
  were rewritten into `nexa/skill/` + `nexa/agent/`.
- **Proof it was behavior-identical:** every new file byte-identical to the old `nexalance`; after
  `apply`, every patched file byte-identical to the old `nexalance`; the applied source therefore equals
  the code that was already validated + running on :28128. Rollback anchor: branch
  `pre-child-theme-migration`.

Result: `git diff upstream-main..nexalance -- . ':(exclude)nexa/'` is EMPTY — base is pristine, all
customization is in `nexa/`.

## 3. The engine (`nexa/lib/overlay.mjs`)

Dependency-free Node ESM. Key functions: `checkPristine`/`assertPristine` (guard), `checkPatches`
(`git apply --check --3way` per patch), `applyOverlay` (git apply --3way + copy `new/` + write
`nexa/.work/applied.json` marker), `restore` (ref-based `git checkout upstream-main -- …` + remove new
files + clear marker), `listPatches`/`patchTarget` (target = the `+++ b/` line — slug reversal is
unsafe for `__tests__` paths), `baseVersion`. CLIs wrap these: `apply.mjs [--check]`, `restore.mjs`,
`build.mjs`, `status.mjs`, `update.mjs`, `setup.mjs`, `gen-manifest.mjs`, `check/pristine-base.mjs`.

## 4. Engine lessons (do not regress)

- **Restore is REF-based, never index-based.** `git checkout -- <path>` restores from the index, which
  is ambiguous while the migration/commit state varies and once left the files customized. Use
  `git checkout upstream-main -- <path>` — pristine is defined by the ref, not the index.
- **`:(literal)` on checkout paths, NOT `GIT_LITERAL_PATHSPECS=1` globally.** One target has glob-magic
  (`src/app/(dashboard)/dashboard/providers/[id]/components/ProviderModalsPanel.tsx`). Prefix such paths
  with `:(literal)`. Setting `GIT_LITERAL_PATHSPECS=1` globally ALSO disables the `:(exclude)nexa/`
  magic the guard depends on → the guard then flags `nexa/` itself and `apply` aborts.
- **Never commit an APPLIED tree.** `build.mjs` restores in a `finally`; the marker (`nexa/.work/
applied.json`) + `status.mjs` detect the applied state.

## 5. Deploy details (carried from the live setup)

Production standalone only. `node nexa/build.mjs` = apply → `npm run build` → auto-restore; output in
`.build/next/standalone` (relocatable). launchd service `com.nexalance.omniroute-test` on :28128 runs
`node dev/run-standalone.mjs` from that dir. Always smoke OUT-OF-BAND first: `(cd .build/next/standalone
&& PORT=28129 DATA_DIR=/tmp/omni-smoke node dev/run-standalone.mjs)` — you MUST `cd` in (server.js
resolves off CWD; running from repo root = `Cannot find module …/server.js` = health `000`). Kill by
port (`kill $(lsof -ti tcp:28129)`). Only then `launchctl kickstart -k gui/$(id -u)/…`.

## 6. Boot-crash post-mortems (health `000` after a build)

`000` = connection refused ⇒ server never bound. Read `/tmp/omniroute-28128.log` first, then (most
likely first):

1. **A new build-time module wasn't synced.** Any NEW `scripts/build/*.mjs` that `run-standalone.mjs`
   imports (e.g. `startupGuard.mjs`) must be added to `assembleStandalone.mjs`'s sync list
   (`dest: ["build","…"]`) — that edit is a patch in `nexa/patches/`. Missing → `ERR_MODULE_NOT_FOUND`.
   Emergency: `cp scripts/build/X.mjs .build/next/standalone/build/X.mjs` then kickstart; fix the patch.
2. **`startupGuard` (H2) deliberately refused** a public/non-loopback bind when `REQUIRE_API_KEY` is off
   or `INITIAL_PASSWORD`/`DASHBOARD_PASSWORD` is `CHANGEME`. Correct behavior — fix the env (or
   `OMNIROUTE_ALLOW_INSECURE_PUBLIC` for a known-local test).
3. **Stale/missing build-time `.env` copy.** The standalone reads `.build/next/standalone/.env`, not the
   root `.env`. Re-copy it.

- **tsc-ratchet after an update:** upstream may add TS errors — theirs, not ours. Baseline
  (`config/quality/tsc-error-baseline.json`, applied from `nexa/new/`) is down-only; hand-edit `value`
  to the new count when upstream RAISED it (confirm our code added 0 via a stash-compare). The app
  builds regardless (`next.config` `ignoreBuildErrors:true`); this is only a quality gate.

## 7. Phase 2 — shrink the overlay (upstream contribution)

The 46 `upstream-candidate` patches are generic fixes worth PRing to `diegosouzapw/OmniRoute`
(responsive maintainer — merged several already). Once merged upstream, the fix arrives via the pristine
base on the next `update`, and you delete the patch. Cut each PR from **pristine `upstream-main`**, not
`nexalance`:

```bash
git worktree add -b upstream-pr/<slug> /tmp/omni-pr upstream-main    # pristine base
# reconstruct the fix on the new pristine file, add a focused test in tests/unit/<name>.test.ts
ln -s "$PWD/node_modules" /tmp/omni-pr/node_modules
( cd /tmp/omni-pr && node --import tsx --import ./open-sse/utils/setupPolyfill.ts \
    --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit tests/unit/<name>.test.ts )
git -C /tmp/omni-pr add -A && git -C /tmp/omni-pr commit -m "fix(scope): …"
git -C /tmp/omni-pr push -u origin upstream-pr/<slug>
gh pr create --repo diegosouzapw/OmniRoute --base main --head developerjillur:upstream-pr/<slug> --title "…" --body "…"
git worktree remove --force /tmp/omni-pr
```

Proven upstream merges (living-fork era, same fixes): #6451 Set-Cookie redaction, #6452 Antigravity 403.
Prefer candidates with a pure exported function (trivially unit-testable); route handlers whose logic is
a local function → integration tests. **Not every candidate belongs upstream** — skip ones that fight
the maintainer's roadmap (e.g. M7 cloud-sync fail-closed, which upstream keeps fail-open until v3.9),
are coupled to NexaConnect schema, or can't be cleanly tested.

**Plugin conversion does NOT work for our patches (rigorously verified 2026-07-07 — do not re-attempt).**
The plugin API (`onRequest`/`onResponse`/`onError`, VM-sandboxed) fires only at the outer HTTP boundary
and hands `onResponse` a GENERIC payload object, not the HTTP Response — so it **cannot mutate response
headers**, **does not see streaming/SSE responses** (they finalize at the transport layer before hooks),
has **no visibility into combo internals** (attempt order / pool state), and runs **after** the
idempotency cache check. `onError` is fire-and-forget (can't mutate the error response). Net: our
`earlyStreamKeepalive` (streaming headers), `combo.ts`+`error.ts` diagnostics, and idempotency-fusion
patches are NOT-CONVERTIBLE (combo diagnostics could at best be a fire-and-forget log shadow that
doesn't achieve the goal). Plugins also aren't synced into the standalone by `assembleStandalone.mjs`.
**Keep these as surgical patches and shrink them via upstream PRs instead.** `nexa/plugins/` stays in the
layout only for a hypothetical future buffered request/response-BODY use (none today).

## 8. The manifest (`nexa/manifest.json`)

Regenerate with `node nexa/gen-manifest.mjs`. Records every item: `layer` (patch/new/tooling), `class`
(upstream-candidate / nexa-specific / needs-review — seeded from the recovered legacy map), `target`
(the upstream file), `conflictRisk`, `upstreamPR`. Use it to pick Phase-2 promotion candidates and to
audit what the overlay carries. Base pin: `upstreamBase.{sha,version}`.
