#!/bin/bash
# Build in isolation; preserve a verified native Bridge package on deploy and rollback.
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"
unset ELECTRON_RUN_AS_NODE
MODE="${1:-update}"
REPO="$HOME/Developer/OmniRoute"
RUNTIME="$HOME/.omniroute-runtime"
DATA_DIR="$HOME/.omniroute-local"
BUILDS="$HOME/.omniroute-builds"
DOMAIN="gui/$(id -u)"
LABEL="com.nexalance.omniroute"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TOOLS="$REPO/nexa/deploy"
STATUS="$DATA_DIR/update-status.json"
NPM=(/usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npm-cli.js)
say() { echo "[$(date '+%F %T')] $*"; }
status() { /usr/local/bin/node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({state:process.argv[2],mode:process.argv[3],message:process.argv[4],at:new Date().toISOString()}));' "$STATUS" "$1" "$MODE" "$2"; say "$1: $2"; }
fail() { status failed "$1"; exit 1; }
healthy() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:28128/healthz)" = 200 ]; }
wait_ready() { local elapsed=0; while [ "$elapsed" -lt "${NEXA_READY_TIMEOUT_SECONDS:-180}" ]; do if healthy && node "$TOOLS/bridge-gate.mjs" live "$DATA_DIR"; then return 0; fi; sleep 2; elapsed=$((elapsed+2)); done; return 1; }
stop_svc() { launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true; local waited=0; while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; do [ "$waited" -lt 60 ] || return 1; sleep 1; waited=$((waited+1)); done; }
start_svc() { launchctl bootstrap "$DOMAIN" "$PLIST"; }
case "$MODE" in update|redeploy|build-only) ;; *) echo "usage: $0 update|redeploy|build-only"; exit 2 ;; esac
mkdir -p "$BUILDS"
if ! mkdir "$BUILDS/.lock" 2>/dev/null; then
  HOLDER="$(cat "$BUILDS/.lock/pid" 2>/dev/null || true)"
  if [[ "$HOLDER" =~ ^[0-9]+$ ]] && ps -p "$HOLDER" -o command= | grep -q 'omni-updater.sh'; then say "another update is running"; exit 0; fi
  mv "$BUILDS/.lock" "$BUILDS/lock-stale-$(date +%Y%m%d-%H%M%S)"
  mkdir "$BUILDS/.lock"
fi
printf '%s\n' "$$" > "$BUILDS/.lock/pid"
trap 'node "$TOOLS/release-lock.mjs" "$BUILDS/.lock" "$$"' EXIT
cd "$REPO"
[ "$(git branch --show-current)" = nexalance ] || fail "Source is not on nexalance"
[ -z "$(git status --porcelain)" ] || fail "Source tree has uncommitted changes; live service untouched"
STAMP="$(date +%Y%m%d-%H%M%S)"
if [ "$MODE" = update ]; then
  status running "checking the newest stable upstream release"
  git tag "nexa-prelease-$STAMP" nexalance
  if ! node nexa/update.mjs > "$BUILDS/update-$STAMP.log" 2>&1; then fail "Upstream update failed; live service untouched"; fi
  if ! node nexa/apply.mjs --check; then fail "An overlay patch needs review; live service untouched"; fi
  SHA="$(git rev-parse --short HEAD)"
  if [ -f "$BUILDS/current" ] && grep -q -- "-$SHA/" "$BUILDS/current"; then
    node "$TOOLS/bridge-gate.mjs" package "$(cat "$BUILDS/current")" && healthy && node "$TOOLS/bridge-gate.mjs" live "$DATA_DIR" || fail "Current service or native Bridge failed verification"
    status ok "already running the newest verified build"; exit 0
  fi
fi
SHA="$(git rev-parse --short HEAD)"
VER="$(node -p 'require("./package.json").version')"
OUTDIR="$BUILDS/$VER-$SHA"
TGZ="$OUTDIR/omniroute-$VER.tgz"
if [ -n "${NEXA_DEPLOY_ARTIFACT:-}" ]; then TGZ="$NEXA_DEPLOY_ARTIFACT"; fi
if [ -f "$TGZ" ]; then
  node "$TOOLS/bridge-gate.mjs" package "$TGZ" || fail "Existing artifact rejected; live service untouched"
else
[ ! -e "$OUTDIR" ] || fail "Incomplete build destination exists; inspect it before retrying"
mkdir "$OUTDIR"
BUILD_TREE="$REPO/.claude/worktrees/bridge-build-$STAMP"
status running "building $VER ($SHA) in $BUILD_TREE"
git worktree add --detach "$BUILD_TREE" nexalance
if [ -d "$REPO/node_modules" ] && [ -f "$BUILDS/.lock-root" ] && cmp -s package-lock.json "$BUILDS/.lock-root"; then
  cp -al "$REPO/node_modules" "$BUILD_TREE/node_modules"
else
  (cd "$BUILD_TREE" && npm ci --no-fund --no-audit) || fail "Dependency install failed; live service untouched"
fi
cd "$BUILD_TREE"
node nexa/apply.mjs
if ! (
  npm run typecheck:core &&
  NODE_OPTIONS=--max-old-space-size=8192 node scripts/check/check-tsc-ratchet.mjs --ratchet | tee "$OUTDIR/tsc-ratchet.log" &&
  ! grep -q 'tscErrors=SKIP' "$OUTDIR/tsc-ratchet.log" &&
  node --import tsx/esm --test tests/unit/agent-bridge-native-transport.test.ts tests/unit/agent-bridge-runtime-state.test.ts tests/unit/traffic-inspector-event-stream.test.ts tests/unit/agent-bridge-selected-dns.test.ts tests/unit/security/audit-remediation.test.ts tests/unit/security/audit-remediation-guards.test.ts tests/unit/provider-validation-ssrf-guard.test.ts tests/unit/combo-diagnostics-trace.test.ts tests/unit/idempotency-fusion-collision.test.ts tests/unit/mitm-server-claude-code-routing.test.ts &&
  npm run build:release && npm run build:cli-api && npm run build:cli &&
  OMNIROUTE_ALLOW_CANARY_BUILD=1 npm run check:pack-artifact &&
  "${NPM[@]}" pack --pack-destination "$OUTDIR"
); then node nexa/restore.mjs; fail "Build/validation failed; live service untouched; isolated build kept"; fi
# Desktop shell uses the same overlay build; failure retains the installed shell.
if [ -d "$REPO/electron/node_modules" ] && [ -f "$BUILDS/.lock-electron" ] && cmp -s electron/package-lock.json "$BUILDS/.lock-electron"; then
  cp -al "$REPO/electron/node_modules" electron/node_modules
else
  (cd electron && npm ci --no-fund --no-audit) || (cd electron && npm install --no-fund --no-audit)
fi
if (cd electron && npm run prepare:bundle && npx --no-install electron-builder --dir --arm64); then
  ditto electron/dist-electron/mac-arm64/OmniRoute.app "$OUTDIR/OmniRoute.app"
else say "WARNING: desktop build failed; installed shell will be retained"; fi
node nexa/restore.mjs
git checkout upstream-main -- bin/cli/api-commands electron/package-lock.json
fi
node "$TOOLS/bridge-gate.mjs" package "$TGZ" > "$OUTDIR/bridge-package-verification.json"
SMOKE_ROOT="$BUILDS/smoke-$STAMP"
node "$TOOLS/smoke-package.mjs" "$TGZ" "$SMOKE_ROOT" > "$OUTDIR/isolated-smoke-$STAMP.json" || fail "Isolated package smoke failed; live service untouched"
if [ "$MODE" = build-only ]; then status ok "verified package built at $TGZ; live service untouched"; exit 0; fi
cd "$REPO"
python3 "$TOOLS/snapshot-local.py" "$DATA_DIR/update-backups/$STAMP" > "$OUTDIR/private-backup-location.json"
PREV="$(cat "$BUILDS/current")"
node "$TOOLS/bridge-gate.mjs" package "$PREV" || fail "Rollback package lacks Bridge fixes; establish a verified rollback package before deploying"
status running "installing $VER ($SHA); verified rollback package preserved"
STAGED_RUNTIME="$SMOKE_ROOT/runtime"
RUNTIME_BACKUP="$BUILDS/runtime-backups/$STAMP"
FAILED_RUNTIME="$BUILDS/runtime-backups/failed-$STAMP"
mkdir -p "$BUILDS/runtime-backups"
[ ! -e "$RUNTIME_BACKUP" ] && [ ! -e "$FAILED_RUNTIME" ] || fail "Runtime backup destination exists; live service untouched"
python3 "$TOOLS/preserve-runtime-extras.py" "$RUNTIME" "$STAGED_RUNTIME"
say "Promoting $STAGED_RUNTIME; preserving the complete current prefix at $RUNTIME_BACKUP"
stop_svc
mv "$RUNTIME" "$RUNTIME_BACKUP"
if mv "$STAGED_RUNTIME" "$RUNTIME" && start_svc && wait_ready; then
  printf '%s\n' "$RUNTIME_BACKUP" > "$BUILDS/previous-runtime"
  printf '%s\n' "$PREV" > "$BUILDS/previous"
  printf '%s\n' "$TGZ" > "$BUILDS/current"
  if [ -d "$OUTDIR/OmniRoute.app" ]; then
    APP=/Applications/OmniRoute.app
    WAS_OPEN=0; pgrep -f "$APP/Contents/MacOS/OmniRoute" >/dev/null && WAS_OPEN=1
    pkill -TERM -f "$APP/Contents/MacOS/OmniRoute" 2>/dev/null || true
    sleep 2
    mkdir -p "$BUILDS/app-backups"
    [ ! -d "$APP" ] || mv "$APP" "$BUILDS/app-backups/OmniRoute-$STAMP.app"
    if ditto "$OUTDIR/OmniRoute.app" "$APP"; then
      [ "$WAS_OPEN" = 0 ] || env -u ELECTRON_RUN_AS_NODE open -a "$APP"
    else
      [ ! -e "$APP" ] || mv "$APP" "$BUILDS/app-backups/failed-$STAMP.app"
      [ ! -d "$BUILDS/app-backups/OmniRoute-$STAMP.app" ] || mv "$BUILDS/app-backups/OmniRoute-$STAMP.app" "$APP"
      say "WARNING: desktop copy failed; installed shell restored"
    fi
  fi
  git -C "$REPO" push origin nexalance upstream-main || say "WARNING: fork backup push failed"
  status ok "running $VER ($SHA), isolated package and native Bridge TLS checks passed"
else
  status running "deploy failed; restoring the verified previous Bridge build"
  stop_svc
  [ ! -e "$RUNTIME" ] || mv "$RUNTIME" "$FAILED_RUNTIME"
  if mv "$RUNTIME_BACKUP" "$RUNTIME" && start_svc && wait_ready; then
    fail "New build rejected; previous service and Bridge restored"
  else fail "ROLLBACK FAILED: inspect service and Bridge logs"; fi
fi
# Preserve archives and isolated build evidence; cleanup is an explicit owner operation.
