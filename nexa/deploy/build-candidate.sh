#!/bin/bash
set -euo pipefail
OUTDIR="$1"
npx --no-install fumadocs-mdx
npm run typecheck:core
node --test --test-concurrency=1 nexa/deploy/bootstrap-launchdaemon.test.mjs nexa/deploy/native-ingress.test.mjs nexa/deploy/ensure-free-space.test.mjs nexa/deploy/stop-owned-bridge.test.mjs nexa/deploy/run-bounded-build.test.mjs nexa/deploy/bridge-gate.test.mjs
node scripts/check/check-tsc-ratchet.mjs --ratchet | tee "$OUTDIR/tsc-ratchet.log"
! grep -q 'tscErrors=SKIP' "$OUTDIR/tsc-ratchet.log"
node nexa/deploy/run-bridge-tests.mjs
node --import tsx/esm --test --test-concurrency=1 tests/unit/chatcore-upstream-body.test.ts tests/unit/model-family-fallback-notation.test.ts tests/unit/claude-code-obfuscation.test.ts tests/unit/claude-native-passthrough-tools.test.ts tests/unit/claude-code-tool-casing-identity-echo.test.ts tests/unit/claude-codex-identity-version-sync.test.ts
node --import tsx/esm --test --test-concurrency=1 tests/unit/traffic-inspector-event-stream.test.ts tests/unit/security/audit-remediation.test.ts tests/unit/security/audit-remediation-guards.test.ts tests/unit/provider-validation-ssrf-guard.test.ts tests/unit/combo-diagnostics-trace.test.ts tests/unit/idempotency-fusion-collision.test.ts
npm run build:release
npm run build:cli-api
npm run build:cli
OMNIROUTE_ALLOW_CANARY_BUILD=1 npm run check:pack-artifact
/usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npm-cli.js pack --pack-destination "$OUTDIR"
