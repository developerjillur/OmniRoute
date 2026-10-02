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
wait_ready() { local elapsed=0; while [ "$elapsed" -lt 180 ]; do if healthy && node "$TOOLS/bridge-gate.mjs" live "$DATA_DIR"; then return 0; fi; sleep 2; elapsed=$((elapsed+2)); done; return 1; }
stop_svc() { launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true; }
start_svc() { launchctl bootstrap "$DOMAIN" "$PLIST"; }
case "$MODE" in update|redeploy|build-only) ;; *) echo "usage: $0 update|redeploy|build-only"; exit 2 ;; esac
mkdir -p "$BUILDS"
mkdir "$BUILDS/.lock" 2>/dev/null || { say "another update is running"; exit 0; }
trap 'rmdir "$BUILDS/.lock" 2>/dev/null || true' EXIT
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
  if [ -f "$BUILDS/current" ] && grep -q -- "-$SHA/" "$BUILDS/current"; then status ok "already running the newest verified build"; exit 0; fi
fi
SHA="$(git rev-parse --short HEAD)"
VER="$(node -p 'require("./package.json").version')"
OUTDIR="$BUILDS/$VER-$SHA"
[ ! -e "$OUTDIR" ] || fail "Build destination already exists; preserving it for review"
mkdir "$OUTDIR"
BUILD_TREE="$REPO/.claude/worktrees/bridge-build-$STAMP"
status running "building $VER ($SHA) in $BUILD_TREE"
git worktree add --detach "$BUILD_TREE" nexalance
cp -al "$REPO/node_modules" "$BUILD_TREE/node_modules"
cd "$BUILD_TREE"
node nexa/apply.mjs
if ! (
  npm run typecheck:core &&
  node scripts/check/check-tsc-ratchet.mjs --ratchet &&
  node --import tsx/esm --test tests/unit/agent-bridge-native-transport.test.ts tests/unit/agent-bridge-runtime-state.test.ts tests/unit/traffic-inspector-event-stream.test.ts tests/unit/mitm-server-claude-code-routing.test.ts &&
  npm run build:release && npm run build:cli-api && npm run build:cli &&
  OMNIROUTE_ALLOW_CANARY_BUILD=1 npm run check:pack-artifact &&
  "${NPM[@]}" pack --pack-destination "$OUTDIR"
); then node nexa/restore.mjs; fail "Build/validation failed; live service untouched; isolated build kept"; fi
node nexa/restore.mjs
TGZ="$OUTDIR/omniroute-$VER.tgz"
node "$TOOLS/bridge-gate.mjs" package "$TGZ" > "$OUTDIR/bridge-package-verification.json"
if [ "$MODE" = build-only ]; then status ok "verified package built at $TGZ; live service untouched"; exit 0; fi
cd "$REPO"
python3 "$TOOLS/snapshot-local.py" "$DATA_DIR/update-backups/$STAMP" > "$OUTDIR/private-backup-location.json"
PREV="$(cat "$BUILDS/current")"
node "$TOOLS/bridge-gate.mjs" package "$PREV" || fail "Rollback package lacks Bridge fixes; establish a verified rollback package before deploying"
status running "installing $VER ($SHA); verified rollback package preserved"
stop_svc
if "${NPM[@]}" install -g --prefix "$RUNTIME" --no-fund --no-audit "$TGZ" && start_svc && wait_ready; then
  printf '%s\n' "$PREV" > "$BUILDS/previous"
  printf '%s\n' "$TGZ" > "$BUILDS/current"
  status ok "running $VER ($SHA), service and native Bridge TLS checks passed"
else
  status running "deploy failed; restoring the verified previous Bridge build"
  stop_svc
  if "${NPM[@]}" install -g --prefix "$RUNTIME" --no-fund --no-audit "$PREV" && start_svc && wait_ready; then
    fail "New build rejected; previous service and Bridge restored"
  else fail "ROLLBACK FAILED: inspect service and Bridge logs"; fi
fi
# Preserve archives and isolated build evidence; cleanup is an explicit owner operation.
