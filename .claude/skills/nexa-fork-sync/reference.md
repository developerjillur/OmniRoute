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
#   (cd .build/next/standalone && PORT=28129 DATA_DIR=/tmp/omni-smoke node dev/run-standalone.mjs)  # MUST cd first — server.js resolves off CWD
launchctl kickstart -k "gui/$(id -u)/com.nexalance.omniroute-test"   # flip live, then re-smoke :28128
git branch -D nexa/sync-<sha>
```

Result: fork = v3.8.45 + all customizations, validated, deployed, `nexa:status` = "✓ up to date".

## 5. Failure post-mortems (do not repeat)

- **Standalone boot crash (v3.8.45 deploy):** extracted the bind guard to `scripts/build/startupGuard.mjs`; `run-standalone.mjs` imports `../build/startupGuard.mjs`, but `scripts/build/assembleStandalone.mjs` didn't sync it to `build/` → `ERR_MODULE_NOT_FOUND` → server never boots (ping 000). **Fix:** add a `{ src:["scripts","build","X.mjs"], dest:["build","X.mjs"] }` entry to assembleStandalone's list for ANY new build-time module run-standalone imports. **Emergency recovery:** `cp scripts/build/X.mjs .build/next/standalone/build/X.mjs` then kickstart.
- **npm double-backgrounding:** running `cmd & ; echo` under a background tool tracks only the wrapper; the real command keeps running detached. Run heavy commands in the foreground or via the tool's own background flag, and wait on the actual PID.
- **tsc-ratchet regression false-positive:** after merging upstream, `--ratchet` fails because upstream added errors. The baseline (`config/quality/tsc-error-baseline.json` — OUR file, not upstream's) is **down-only**; `--update` refuses to raise it, so **hand-edit `value`** to the new count (v3.8.45: 2965→3014; confirm our code added 0 first via a stash-compare). Missed once — the v3.8.45 baseline silently stayed 2965 until a later build caught it. `--update` is only for when the count DROPS.
- **node:test misses tests after an interleaved top-level `await import`:** put ALL dynamic imports first, then all `test()` calls.
- **maskSecret is format-aware** (Bearer/`sk-`/≥40-char only) — it does NOT redact arbitrary cookie values; `set-cookie` must be fully redacted, not maskSecret'd.

## 6. CI automation

`.github/workflows/nexa-upstream-sync.yml` runs daily (+ manual dispatch): checks out `nexalance`, adds upstream, `npm ci`, runs `nexa:sync`, then opens a **green auto-mergeable PR** (clean+validated) or an **issue with the report** (conflicts/validation fail). Enable it in the fork's Settings → Actions. It never force-pushes and never touches upstream.

## 7. Validation gate (`.nexa/config.json` → validate[])

1. `npm run typecheck:core` · 2. `check-tsc-ratchet --ratchet` · 3. the customization regression tests. Extend this list when you add a customization + its test, so the sandbox always proves our behavior survived the merge.

## 8. Upstream contribution (shrink-the-fork) — worked example

Goal: move a generic fix from our maintenance set into upstream so it can never conflict again. Cut each PR from **pristine `upstream-main`**, not `nexalance` (which carries our other changes). Proven 2026-07-07 with 4 PRs to `diegosouzapw/OmniRoute` (`diegosouzapw` is **highly responsive — merged the first 2 within minutes**):

- **#6451 MERGED** — `fix(mitm): redact Set-Cookie in sanitizeHeaders` (security). `src/mitm/sanitizeHeaders.ts` + `src/mitm/inspector/agentBridgeHook.ts` + `tests/unit/mitm-sanitize-headers.test.ts`.
- **#6452 MERGED** — `fix(providers): recoverable Antigravity/Cloud-Code 403s` (reliability). `open-sse/services/errorClassifier.ts` + `tests/unit/errorclassifier-antigravity-403.test.ts` (control: real bans still `ACCOUNT_DEACTIVATED`).
- **#6541** — `fix(security): loopback-gate /api/middleware/*` (vm.Script RCE parity with /api/plugins). 1-line `routeGuard.ts` add + `tests/unit/route-guard-middleware-local-only.test.ts`.
- **#6542** — `fix(security): SSRF-guard provider validation probes`. `src/lib/providers/validation/headers.ts` + `tests/unit/provider-validation-ssrf-guard.test.ts`.
- **#6543** — `fix(security): fail-closed CORS for cloud-agent management routes` (was `origin||"*"` + `Allow-Credentials:true` = CSRF hole). `src/lib/cloudAgent/api.ts` + `tests/unit/cloud-agent-cors-failclosed.test.ts`.
- **#6544** — `perf(models): request-coalescing cache for /v1/models` (2s TTL, per-API-key key). `src/app/api/v1/models/{catalogCache.ts(new),catalog.ts}` + `tests/unit/catalog-coalescing-cache.test.ts`.
- **#6545** — `feat(combo): sanitized diagnostic trace on auto-combo terminal failure`. `open-sse/utils/error.ts` (additive infra: `sanitizeComboDiagnostics`+`errorResponseWithComboDiagnostics`) + `open-sse/services/combo.ts` (wiring) + `tests/unit/combo-diagnostics-trace.test.ts` (headers/body + whitelist + secret-containment). The existing fork test covered the _pure_ error.ts core — a good sign the feature was PR-able even though the combo.ts wiring is integration-level.

- **#6553** — `perf(health): short-TTL cache for GET /api/monitoring/health` (1s TTL + DELETE-invalidation). `src/app/api/monitoring/health/route.ts` + `tests/integration/monitoring-health-cache.test.ts`.
- **#6554** — `fix(playground): accept a dashboard session for presets under REQUIRE_API_KEY` (the dashboard 401'd itself). `src/app/api/playground/presets/route.ts` + `tests/integration/presets-dashboard-auth.test.ts`.

Prefer candidates with a **pure exported function** (`sanitizeHeaders`, `classifyProviderError`, `isLocalOnlyPath`, `getCloudAgentCorsHeaders`, `getCoalescedCatalog`) — trivially unit-testable. Route handlers whose logic is a _local_ (unexported) function (e.g. presets `checkAuth`, the health cache) can't be unit-mocked (`mock.module()` is unavailable in this tsx/ESM setup) — test them as **integration tests** instead:

- Runner: `npm run test:integration` (= `node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit --test-concurrency=1 <file>`), files in `tests/integration/**`.
- Set a temp `DATA_DIR`, `await import("../../src/lib/db/core.ts")` to init a real SQLite DB, then import the route's exported `GET/POST/DELETE` and call them with `Request` objects.
- **Dashboard-session auth:** set `JWT_SECRET` (+ `REQUIRE_API_KEY=true` and `INITIAL_PASSWORD=…` so auth is required) and forge the cookie the app verifies — `new SignJWT({authenticated:true}).setProtectedHeader({alg:"HS256"}).setExpirationTime("30d").sign(new TextEncoder().encode(process.env.JWT_SECRET))` (jose) → `headers:{ cookie:'auth_token=<jwt>' }`.
- **Prove the regression:** RED-check by swapping in the pristine route (`git show upstream-main:<route> > <route>` in the worktree) and running — the positive case must FAIL; then restore the fix. (Health cache: assert on the payload's build-time `timestamp` — identical ⇒ cached, fresh ⇒ rebuilt.)

**Not every `upstream-candidate` belongs upstream — read the maintainer's intent first.** `M7 cloud-sync fail-closed` was deliberately NOT PR'd: the upstream code comment says "the enforce-by-default switch will flip in v3.9", i.e. they keep fail-open on purpose until then, so flipping it now contradicts their roadmap. Skip candidates that fight the maintainer's stated plan, are coupled to NexaConnect schema/config, or can't be cleanly tested; they stay in our fork.

Exact recipe (per PR):

```bash
git worktree add -b upstream-pr/<slug> /tmp/omni-pr upstream-main
git -C /tmp/omni-pr checkout nexalance -- <fix's source files>       # our version = upstream + only this fix
git -C /tmp/omni-pr diff --cached --stat                             # sanity: exactly the fix
ln -s "$PWD/node_modules" /tmp/omni-pr/node_modules
# write tests/unit/<name>.test.ts (node:test, relative import) and run ONLY it:
( cd /tmp/omni-pr && node --import tsx --import ./open-sse/utils/setupPolyfill.ts \
    --import ./tests/_setup/isolateDataDir.ts --test --test-force-exit tests/unit/<name>.test.ts )
git -C /tmp/omni-pr add -A && git -C /tmp/omni-pr commit -m "fix(scope): …"
git -C /tmp/omni-pr push -u origin upstream-pr/<slug>
gh pr create --repo diegosouzapw/OmniRoute --base main --head developerjillur:upstream-pr/<slug> --title "…" --body "…"
git worktree remove --force /tmp/omni-pr
```

Gotchas learned: (a) `git checkout <ref> -- <paths>` **stages** the files, so use `diff --cached` to inspect. (b) Put the test in `tests/unit/**` (that's the `test:unit` glob); `open-sse/**/__tests__` is run by a different script. (c) `maskSecret` is format-aware (Bearer/`sk-`/≥40-char) — arbitrary cookie values need **full** redaction, which is exactly why #6451 exists. (d) Keep each PR one concern; upstream reviews small self-contained diffs fastest. (e) **Testing a keyed cache: vary the axis the KEY uses, not one it ignores.** The catalog cache keys on API-key + prefix/version (not arbitrary query params), so a "two different requests" test that only changed the URL got a false cache HIT (build ran 0 times) — namespace test cases by a _different API key_. (f) CORS/allowlist functions read `process.env` (`CORS_ALLOWED_ORIGINS`, `CORS_ALLOW_ALL`) at call time — set/restore them in `beforeEach`/`afterEach` like `tests/unit/cors/origins.test.ts`.

## 9. Fork CI configuration (already applied — don't redo)

- **Default branch switched `main` → `nexalance`** (Settings → General → Default branch). Required: GitHub only runs a workflow's `schedule`/`workflow_dispatch` from the default branch, and our workflow lives on `nexalance`.
- **Actions → General:** "Allow all actions"; Workflow permissions = **Read and write**; **"Allow GitHub Actions to create and approve pull requests"** = ON.
- Verified live: manual `gh workflow run nexa-upstream-sync.yml` (or Actions tab) → run succeeded (npm ci ✓, orchestrator early-exited "up to date"), no spurious PR/issue. The PR/issue steps are gated on `.nexa/last-sync.json` **status** (`clean-validated` → PR; `conflicts`/`validation-failed` → issue), so up-to-date runs no-op cleanly.
