# nexa-fork-sync — deep reference

Everything a future session needs to work on this fork perfectly. Read the SKILL.md first for the workflow; this is the exhaustive backing.

## 1. Why this fork exists

`OmniRoute` (`diegosouzapw/OmniRoute`) is the model gateway NexaConnect uses. We customized it heavily (security-audit fixes, QA remediation, perf, NexaConnect-specific config). Working detached would mean missing every upstream feature/fix. So it's a **living fork**: our changes committed on `nexalance`, upstream merged continuously + sandbox-validated before landing, generic fixes contributed back upstream to shrink the fork.

## 2. Git + remote layout (authoritative)

```
origin    → git@github.com:developerjillur/OmniRoute.git   (OUR fork — push here)
upstream  → https://github.com/diegosouzapw/OmniRoute.git  (source — NEVER push)
branches: nexalance (production = upstream + customizations) · upstream-main (pristine mirror) · main (base)
```

`.nexa/config.json` names the remotes, production branch, sandbox worktree dir, and the validation gate commands. `.nexa/customizations.json` is the generated registry.

## 3. Our customization set (what NOT to lose)

Regenerate the live list any time: `node scripts/nexa-sync/gen-manifest.mjs` → `.nexa/customizations.json`. As of the v3.8.45 sync: ~56 files (18 zero-conflict overlays + 38 modified upstream files), 47 `upstream-candidate` + 9 `nexa-specific`.

**Security (SECURITY_AUDIT_REPORT.md — 9 fixed + tested):** H1 cloud-agent CORS fail-closed (`src/lib/cloudAgent/api.ts`), H2 CHANGEME startup guard (`scripts/build/startupGuard.mjs`+`scripts/dev/run-standalone.mjs`), M1 guardrail per-key gate (`src/lib/guardrails/registry.ts`), M2 server.env 0600 (`scripts/build/bootstrap-env.mjs`,`electron/main.js`), M3 DNS-rebinding guard (`src/shared/network/safeOutboundFetch.ts`), M4 db/health sanitize (`src/app/api/db/health/route.ts`), M6 inspector set-cookie redaction (`src/mitm/sanitizeHeaders.ts`,`agentBridgeHook.ts`), M7 cloud-sync fail-closed (`src/lib/cloudSync.ts`), M8 middleware loopback-gate (`src/server/authz/routeGuard.ts`), L7 isPrivateHost dedup (`src/lib/db/upstreamProxy.ts`), L15 @types/bun pin. Regression tests: `tests/unit/security/audit-remediation.test.ts` + `audit-remediation-guards.test.ts`.

**QA (NEXACONNECT-OMNIROUTE-FULL-QA-REPORT):** auto-combo diagnostics (`open-sse/utils/error.ts`+`open-sse/services/combo.ts`; test `tests/unit/combo-diagnostics-trace.test.ts`), catalog coalescing cache (`src/app/api/v1/models/catalogCache.ts`+`catalog.ts`), streaming metadata headers (`open-sse/utils/earlyStreamKeepalive.ts`), SSRF provider-validation guard (`src/lib/providers/validation/headers.ts`; test `provider-validation-ssrf-guard.test.ts`), CSP prod split (`next.config.mjs`), Electron sandbox (`electron/main.js`,`loginManager.js`), presets dashboard-auth (`src/app/api/playground/presets/route.ts`), `/api/logs` route, CLI health/doctor (`bin/cli/…`), tsc-ratchet (`scripts/check/check-tsc-ratchet.mjs`+`config/quality/tsc-error-baseline.json`), OpenAPI x-loopback-only (`scripts/docs/annotate-loopback-only.mjs`+`docs/openapi.yaml`), health TTL cache (`src/app/api/monitoring/health/route.ts`), Docker profile (`docker-compose.nexaconnect.yml`).

**Antigravity multi-account** (prior work): `open-sse/executors/antigravity.ts`, `antigravityQuotaFamily.ts`, `antigravityProjectBootstrap.ts`, `errorClassifier.ts`.

**Fork tooling (nexa-specific, keep forever):** `scripts/nexa-sync/*`, `.nexa/*`, `.github/workflows/nexa-upstream-sync.yml`, `docker-compose.nexaconnect.yml`, this skill.

## 4. Worked example — the v3.8.45 sync (exact commands)

The v3.8.45 sync hit **conflicts** (shown below). A **clean** sync is shorter: `npm run nexa:sync` exits `0`, the validated branch `nexa/sync-<sha>` is already created + kept, so you skip the manual merge and jump to the `git merge --ff-only` land line. The conflict path:

```bash
git checkout -b nexa/sync-<upstreamShortSha> nexalance
git merge --no-edit upstream/main            # → 4 conflicts
#   resolve KEEPING BOTH sides in: .gitignore, package.json,
#   open-sse/executors/antigravity.ts, open-sse/utils/earlyStreamKeepalive.ts
git add -A && git commit --no-edit           # complete the merge
npm run typecheck:core                        # clean
node --import tsx --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts \
  --test --test-force-exit tests/unit/security/*.test.ts tests/unit/provider-validation-ssrf-guard.test.ts \
  tests/unit/combo-diagnostics-trace.test.ts # 19/19 green
git checkout nexalance && git merge --ff-only nexa/sync-<sha>
node scripts/check/check-tsc-ratchet.mjs --update   # 2965 → 3014 (upstream delta)
node scripts/nexa-sync/gen-manifest.mjs
git add -A && git commit && git push origin nexalance
npm install && npm run build
# NOTE: the current procedure (SKILL "Deploy" step) smokes the build OUT-OF-BAND on a
# throwaway port/data-dir FIRST, and only kickstarts live if that passes:
#   PORT=28129 DATA_DIR=/tmp/omni-smoke node .build/next/standalone/dev/run-standalone.mjs
launchctl kickstart -k "gui/$(id -u)/com.nexalance.omniroute-test"   # flip live, then re-smoke :28128
git branch -D nexa/sync-<sha>
```

Result: fork = v3.8.45 + all customizations, validated, deployed, `nexa:status` = "✓ up to date".

## 5. Failure post-mortems (do not repeat)

- **Standalone boot crash (v3.8.45 deploy):** extracted the bind guard to `scripts/build/startupGuard.mjs`; `run-standalone.mjs` imports `../build/startupGuard.mjs`, but `scripts/build/assembleStandalone.mjs` didn't sync it to `build/` → `ERR_MODULE_NOT_FOUND` → server never boots (ping 000). **Fix:** add a `{ src:["scripts","build","X.mjs"], dest:["build","X.mjs"] }` entry to assembleStandalone's list for ANY new build-time module run-standalone imports. **Emergency recovery:** `cp scripts/build/X.mjs .build/next/standalone/build/X.mjs` then kickstart.
- **npm double-backgrounding:** running `cmd & ; echo` under a background tool tracks only the wrapper; the real command keeps running detached. Run heavy commands in the foreground or via the tool's own background flag, and wait on the actual PID.
- **tsc-ratchet regression false-positive:** after merging upstream, `--ratchet` fails because upstream added errors. Re-baseline with `--update` (only after our tests are green).
- **node:test misses tests after an interleaved top-level `await import`:** put ALL dynamic imports first, then all `test()` calls.
- **maskSecret is format-aware** (Bearer/`sk-`/≥40-char only) — it does NOT redact arbitrary cookie values; `set-cookie` must be fully redacted, not maskSecret'd.

## 6. CI automation

`.github/workflows/nexa-upstream-sync.yml` runs daily (+ manual dispatch): checks out `nexalance`, adds upstream, `npm ci`, runs `nexa:sync`, then opens a **green auto-mergeable PR** (clean+validated) or an **issue with the report** (conflicts/validation fail). Enable it in the fork's Settings → Actions. It never force-pushes and never touches upstream.

## 7. Validation gate (`.nexa/config.json` → validate[])

1. `npm run typecheck:core` · 2. `check-tsc-ratchet --ratchet` · 3. the customization regression tests. Extend this list when you add a customization + its test, so the sandbox always proves our behavior survived the merge.
