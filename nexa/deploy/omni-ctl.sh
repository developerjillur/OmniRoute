#!/usr/bin/env bash
# omni-ctl.sh - control the always-on local OmniRoute (background service + desktop shell)
#
# Where things live (see ../README.md):
#   internal disk : ~/.omniroute-runtime  (npm prefix holding the omniroute package)
#                   ~/.omniroute-local    (database, logs, .env with secrets, mode 600)
#   this kit (T7) : scripts, releases, source, backups
# The service never reads anything from the T7 drive, so it starts even when the drive is unplugged.
# Nothing in this script deletes a data directory or a backup.
set -uo pipefail

LABEL="com.nexalance.omniroute"
HOST="127.0.0.1"
PORT="28128"
NODE_BIN="/usr/local/bin/node"                      # Node 24 LTS from nodejs.org, independent of Hermes and Homebrew
NPM_CLI="/usr/local/lib/node_modules/npm/bin/npm-cli.js"
RUNTIME="$HOME/.omniroute-runtime"
DATA_DIR="$HOME/.omniroute-local"
# launchd stdout/stderr must stay OUTSIDE DATA_DIR/logs: OmniRoute's one-time "legacy request logs"
# migration archives and removes every file it finds in DATA_DIR/logs (it swallowed ours on first boot).
LOG_DIR="$HOME/Library/Logs/OmniRoute"
PKG_DIR="$RUNTIME/lib/node_modules/omniroute"
CLI="$PKG_DIR/bin/omniroute.mjs"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
APP="/Applications/OmniRoute.app"
URL="http://$HOST:$PORT"
KIT="/Volumes/T7 Shield/NexaLance-Resources/Local-OmniRoute-Setup"
SVC_PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
DEFAULT_VERSION="3.8.51"

say()  { printf '%s\n' "$*"; }
warn() { printf 'warn: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

need_runtime() { [ -f "$CLI" ] || die "omniroute is not installed in $PKG_DIR (run: omni-ctl.sh install)"; }
pkg_version()  { if [ -f "$PKG_DIR/package.json" ]; then "$NODE_BIN" -p "require('$PKG_DIR/package.json').version"; else echo "not installed"; fi; }
is_loaded()    { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }
svc_field()    { launchctl print "$DOMAIN/$LABEL" 2>/dev/null | sed -n "s/^[[:space:]]*$1 = //p" | head -1; }
http_code()    { curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$URL$1" 2>/dev/null || true; }
ready()        { [ "$(http_code /healthz)" = "200" ]; }
# bootout returns before the job is gone (graceful shutdown, ExitTimeOut 40s); bootstrapping too early fails with "Input/output error".
unload()       { launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null; local waited=0; while is_loaded; do [ "$waited" -ge "${1:-60}" ] && return 1; sleep 1; waited=$((waited + 1)); done; return 0; }
wait_ready()   { local limit="${1:-150}" waited=0; while [ "$waited" -lt "$limit" ]; do ready && return 0; sleep 2; waited=$((waited + 2)); done; return 1; }
npm_run()      { PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" "$NODE_BIN" "$NPM_CLI" "$@"; }
# Port, host and secrets come from DATA_DIR/.env. The base URL is pinned on top because `mcp call` falls back to a
# hard-coded http://localhost:20128 when none is given (bin/cli/commands/mcp.mjs). Note that `mcp call` also needs a
# management-scoped API key, which this kit deliberately does not create or store.
# The CLI prints ~15 "X in <package>/.env is ignored, <DATA_DIR>/.env set it first" lines on every run (no flag turns
# that off, and the overlap is intended: the durable .env must win over the package one). run_cli keeps a real TTY for
# interactive use; run_cli_quiet always filters that noise out and keeps the CLI's exit status.
run_cli() { need_runtime; env DATA_DIR="$DATA_DIR" OMNIROUTE_BASE_URL="$URL" PATH="$SVC_PATH" "$NODE_BIN" "$CLI" "$@"; }
run_cli_quiet() {
  need_runtime
  local esc=$'\033'
  env DATA_DIR="$DATA_DIR" OMNIROUTE_BASE_URL="$URL" PATH="$SVC_PATH" "$NODE_BIN" "$CLI" "$@" 2>&1 \
    | sed -E "s/${esc}\[[0-9;]*m//g" \
    | grep -v -E '^[[:space:]]+(📋 Loaded env from |⚠ .+ (is ignored, .+ set it first|lives inside the installed package))'
  return "${PIPESTATUS[0]}"
}

# ---------------------------------------------------------------------------
# LaunchAgent. Same invocation the package uses for its own Linux unit
# (`serve --no-open`, foreground, headless) plus what the stock macOS
# `omniroute autostart` plist lacks: restart on crash, logs, fixed Node path,
# dedicated data dir and port.
# ---------------------------------------------------------------------------
render_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$CLI</string>
    <string>serve</string>
    <string>--no-open</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DATA_DIR</key><string>$DATA_DIR</string>
    <key>PORT</key><string>$PORT</string>
    <key>OMNIROUTE_PORT</key><string>$PORT</string>
    <key>OMNIROUTE_SERVER_HOST</key><string>$HOST</string>
    <key>PATH</key><string>$SVC_PATH</string>
  </dict>
  <key>WorkingDirectory</key><string>$DATA_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ExitTimeOut</key><integer>40</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/service.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/service.err.log</string>
</dict>
</plist>
EOF
}

# MACHINE_ID_SALT lives in the package-level .env, which `npm install` replaces on every update. The machine ID
# derived from it is embedded in API keys (sk-<machine>-...). In 3.8.51 the shipped value is the constant
# "endpoint-proxy-salt", so pinning it is a precaution: a future release that changes it cannot invalidate keys.
pin_machine_salt() {
  local f="$DATA_DIR/.env" pkgenv="$PKG_DIR/.env" salt=""
  [ -f "$f" ] || return 0
  grep -q '^MACHINE_ID_SALT=' "$f" && return 0
  [ -f "$pkgenv" ] && salt="$(sed -n 's/^MACHINE_ID_SALT=//p' "$pkgenv" | head -1)"
  [ -n "$salt" ] || salt="omniroute-$(openssl rand -hex 8)"
  printf '\n# Pinned so package updates never change the machine ID embedded in API keys\nMACHINE_ID_SALT=%s\n' "$salt" >> "$f"
  say "pinned MACHINE_ID_SALT in $f"
}

# Other tools add their own env to the service plist (e.g. the Agent Bridge: NODE_OPTIONS hook, MITM_*).
# When this script rewrites the plist, copy every key it does not own from the old file into the new one.
keep_extra_env() {
  local old="$1" new="$2" k v
  [ -f "$old" ] || return 0
  for k in $(plutil -extract EnvironmentVariables json -o - "$old" 2>/dev/null \
      | "$NODE_BIN" -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));const mine=new Set(["DATA_DIR","PORT","OMNIROUTE_PORT","OMNIROUTE_SERVER_HOST","PATH"]);for(const k of Object.keys(o)) if(!mine.has(k)) console.log(k)'); do
    v="$(plutil -extract "EnvironmentVariables.$k" raw -o - "$old" 2>/dev/null)" || continue
    plutil -replace "EnvironmentVariables.$k" -string "$v" "$new" && say "kept $k from the existing plist"
  done
}

# Creates DATA_DIR/.env with fresh secrets only when it does not exist yet.
ensure_env() {
  local f="$DATA_DIR/.env"
  mkdir -p "$DATA_DIR/logs"; chmod 700 "$DATA_DIR"
  [ -f "$f" ] && { pin_machine_salt; return 0; }
  # Fresh secrets next to an existing database would lock out every stored credential and API key
  # (upstream refuses the same thing in bin/omniroute.mjs). Restore the old .env instead.
  [ -f "$DATA_DIR/storage.sqlite" ] && die "$DATA_DIR/storage.sqlite exists but $f is missing: restore the old .env (backup --with-secrets keeps one) instead of generating new secrets"
  say "creating $f with new secrets"
  (
    umask 077
    cat > "$f" <<EOF
# OmniRoute local service config. Keep mode 600. Never commit or share.
# Losing STORAGE_ENCRYPTION_KEY means re-entering every provider login.
PORT=$PORT
OMNIROUTE_PORT=$PORT
OMNIROUTE_SERVER_HOST=$HOST
BASE_URL=http://localhost:$PORT
NEXT_PUBLIC_BASE_URL=http://localhost:$PORT
REQUIRE_API_KEY=true
AUTH_COOKIE_SECURE=false
ALLOW_API_KEY_REVEAL=false
INITIAL_PASSWORD=$(openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 20)
JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
API_KEY_SECRET=$(openssl rand -hex 32)
STORAGE_ENCRYPTION_KEY=$(openssl rand -hex 32)
STORAGE_ENCRYPTION_KEY_VERSION=v1
NODE_ENV=production
OMNIROUTE_MEMORY_MB=8192
# Always-on loopback helpers moved off the upstream 2013x defaults
LIVE_WS_PORT=28132
EMBED_WS_PROXY_PORT=28131
# The server plugin scanner ignores DATA_DIR and would default to ~/.omniroute/plugins
OMNIROUTE_PLUGINS_DIR=$DATA_DIR/plugins
EOF
  )
  mkdir -p "$DATA_DIR/plugins"
  chmod 600 "$f"
  pin_machine_salt
}

# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------
cmd_install() {
  [ -x "$NODE_BIN" ] || die "$NODE_BIN not found (install Node 24 LTS from nodejs.org)"
  local want="${1:-$DEFAULT_VERSION}"
  if [ "$(pkg_version)" != "$want" ]; then
    say "installing omniroute@$want into $RUNTIME"
    mkdir -p "$RUNTIME"
    npm_run install -g --prefix "$RUNTIME" --no-fund --no-audit "omniroute@$want" || die "npm install failed"
  else
    say "omniroute $want already installed"
  fi
  ensure_env
  cmd_enable
}

cmd_enable() {
  need_runtime
  ensure_env
  mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
  render_plist > "$PLIST.tmp"
  keep_extra_env "$PLIST" "$PLIST.tmp"
  mv "$PLIST.tmp" "$PLIST"
  chmod 600 "$PLIST"
  plutil -lint "$PLIST" >/dev/null || die "generated plist is invalid"
  unload 60 || die "previous instance is still shutting down, try again in a minute"
  launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST" || die "launchctl bootstrap failed"
  say "auto-start ON: starts at every login, restarts after a crash"
  say "waiting for the server (first start can take up to a minute)..."
  if wait_ready 150; then say "ready: $URL"; else warn "not ready yet, check: omni-ctl.sh logs"; return 1; fi
}

cmd_disable() {
  unload 60 || warn "service still shutting down"
  launchctl disable "$DOMAIN/$LABEL" 2>/dev/null || true
  say "auto-start OFF and service stopped (plist kept at $PLIST; 'enable' turns it back on)"
}

cmd_start() {
  if is_loaded; then launchctl kickstart "$DOMAIN/$LABEL" >/dev/null 2>&1 || true; else cmd_enable; return; fi
  if wait_ready 150; then say "ready: $URL"; else warn "not ready yet, check: omni-ctl.sh logs"; return 1; fi
}

cmd_stop() {
  if is_loaded; then unload 60 && say "stopped (it starts again at next login, or run: omni-ctl.sh start)" || warn "still shutting down"; else say "was not running"; fi
}

cmd_restart() {
  if is_loaded; then launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1; else cmd_enable; return; fi
  if wait_ready 150; then say "ready: $URL"; else warn "not ready yet, check: omni-ctl.sh logs"; return 1; fi
}

cmd_status() {
  say "OmniRoute local service"
  say "  package      : $(pkg_version)   (node: $("$NODE_BIN" --version))"
  say "  dashboard    : $URL"
  say "  api (OpenAI) : $URL/v1"
  if is_loaded; then
    say "  launchd      : loaded  state=$(svc_field state)  pid=$(svc_field pid)"
  else
    say "  launchd      : NOT loaded"
  fi
  if [ -f "$PLIST" ] && ! launchctl print-disabled "$DOMAIN" 2>/dev/null | grep -q "\"$LABEL\" => disabled"; then
    say "  auto-start   : ON  ($PLIST)"
  else
    say "  auto-start   : OFF"
  fi
  say "  /healthz     : HTTP $(http_code /healthz)"
  say "  omni.local   : HTTP $(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://omni.local/healthz 2>/dev/null || true)"
  if [ -d "$APP" ]; then
    say "  desktop app  : $(defaults read "$APP/Contents/Info" CFBundleShortVersionString 2>/dev/null) at $APP"
  else
    say "  desktop app  : not installed"
  fi
  say "  data dir     : $DATA_DIR  ($(du -sh "$DATA_DIR" 2>/dev/null | awk '{print $1}'))"
  say "  kit          : $KIT"
}

cmd_health() { local c; c="$(http_code /healthz)"; say "healthz: HTTP $c"; [ "$c" = "200" ]; }

cmd_logs() {
  local f
  for f in "$LOG_DIR/service.err.log" "$LOG_DIR/service.out.log" "$DATA_DIR/logs/application/app.log"; do
    [ -f "$f" ] && { say "== $f"; tail -n "${OMNI_LOG_LINES:-40}" "$f" | cut -c1-240; }
  done
  [ "${1:-}" = "-f" ] && exec tail -f "$LOG_DIR/service.out.log" "$LOG_DIR/service.err.log" "$DATA_DIR/logs/application/app.log"
  return 0
}

cmd_open() { open "$URL"; }

# ELECTRON_RUN_AS_NODE is inherited from VS Code / Electron-based terminals and turns the desktop app
# into a plain Node process that exits silently, so it is always removed here.
cmd_desktop_open() { [ -d "$APP" ] || die "desktop app not installed (omni-ctl.sh install-desktop)"; env -u ELECTRON_RUN_AS_NODE open -a "$APP"; }

# Consistent online snapshot of the database into the kit's backups/ folder.
# Add --with-secrets to also copy .env (it holds the key that decrypts stored credentials).
cmd_backup() {
  [ -f "$DATA_DIR/storage.sqlite" ] || die "no database yet in $DATA_DIR"
  [ -d "$KIT/backups" ] || die "backup folder $KIT/backups is not reachable (is the T7 drive mounted?)"
  local dest="$KIT/backups/omniroute-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$dest" || die "cannot create $dest"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DATA_DIR/storage.sqlite" ".backup '$dest/storage.sqlite'" || die "sqlite backup failed"
  else
    cp -p "$DATA_DIR/storage.sqlite" "$dest/" || die "copy failed"
    [ -f "$DATA_DIR/storage.sqlite-wal" ] && cp -p "$DATA_DIR/storage.sqlite-wal" "$dest/"
  fi
  if [ "${1:-}" = "--with-secrets" ]; then cp -p "$DATA_DIR/.env" "$dest/env.secret" && warn "env.secret copied: it can decrypt your stored credentials, keep this drive private"; fi
  printf 'package=%s\ncreated=%s\nport=%s\n' "$(pkg_version)" "$(date -u +%FT%TZ)" "$PORT" > "$dest/backup.info"
  say "backup written: $dest ($(du -sh "$dest" | awk '{print $1}'))"
}

# ---------------------------------------------------------------------------
# One-click updates of the NexaLance overlay build (fork developerjillur/OmniRoute, branch nexalance,
# source in ~/Developer/OmniRoute). The dashboard "Update" button runs AUTO_UPDATE_COMMAND
# (AUTO_UPDATE_MODE=command is one of the overlay patches), which only kicks the updater LaunchAgent;
# the updater runs as its own launchd job so it survives the service restart it performs.
# ---------------------------------------------------------------------------
UPD_LABEL="com.nexalance.omniroute-updater"
UPD_PLIST="$HOME/Library/LaunchAgents/$UPD_LABEL.plist"
UPD_DIR="$RUNTIME/updater"
UPD_SOURCE="$HOME/Developer/OmniRoute/nexa/deploy/omni-updater.sh"

cmd_updater_install() {
  [ -f "$UPD_SOURCE" ] || UPD_SOURCE="$KIT/scripts/omni-updater.sh"
  [ -f "$UPD_SOURCE" ] || die "missing $KIT/scripts/omni-updater.sh"
  mkdir -p "$UPD_DIR" "$LOG_DIR"
  cp "$UPD_SOURCE" "$UPD_DIR/omni-updater.sh"; chmod 755 "$UPD_DIR/omni-updater.sh"
  # the mode the next kick runs; the dashboard always means "update"
  printf 'update\n' > "$UPD_DIR/mode"
  cat > "$UPD_DIR/request-update.sh" <<EOF
#!/bin/bash
# Called by OmniRoute (AUTO_UPDATE_COMMAND) when the dashboard Update button is pressed.
printf 'update\n' > "$UPD_DIR/mode"
exec /bin/launchctl kickstart "gui/\$(id -u)/$UPD_LABEL"
EOF
  chmod 755 "$UPD_DIR/request-update.sh"
  cat > "$UPD_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$UPD_LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>-c</string><string>exec "$UPD_DIR/omni-updater.sh" "\$(cat "$UPD_DIR/mode" 2>/dev/null || echo update)"</string></array>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$LOG_DIR/update.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/update.log</string>
</dict>
</plist>
EOF
  plutil -lint "$UPD_PLIST" >/dev/null || die "invalid $UPD_PLIST"
  launchctl bootout "$DOMAIN/$UPD_LABEL" 2>/dev/null; sleep 1
  launchctl bootstrap "$DOMAIN" "$UPD_PLIST" || die "launchctl bootstrap failed for $UPD_LABEL"
  local f="$DATA_DIR/.env"
  if ! grep -q '^AUTO_UPDATE_MODE=' "$f"; then
    printf '\n# Dashboard Update button -> NexaLance overlay updater (patch: AUTO_UPDATE_MODE=command)\nAUTO_UPDATE_MODE=command\nAUTO_UPDATE_COMMAND=%s\nAUTO_UPDATE_LOG_PATH=%s\n' \
      "$UPD_DIR/request-update.sh" "$LOG_DIR/update.log" >> "$f"
    say "added AUTO_UPDATE_* to $f (takes effect after: omni-ctl.sh restart)"
  fi
  say "updater installed: $UPD_LABEL (log: $LOG_DIR/update.log)"
}

cmd_updater_run() {
  [ -f "$UPD_PLIST" ] || cmd_updater_install
  [ -f "$UPD_SOURCE" ] || UPD_SOURCE="$KIT/scripts/omni-updater.sh"
  cp "$UPD_SOURCE" "$UPD_DIR/omni-updater.sh" || die "could not stage the versioned updater"
  printf '%s\n' "$1" > "$UPD_DIR/mode"
  launchctl kickstart "$DOMAIN/$UPD_LABEL" || die "could not start the updater"
  say "$1 started in the background (10-20 min). Follow it with: tail -f $LOG_DIR/update.log"
  say "or check: omni-ctl.sh update-status"
}

cmd_update_status() {
  [ -f "$DATA_DIR/update-status.json" ] && cat "$DATA_DIR/update-status.json" || say "no update has run yet"
  launchctl print "$DOMAIN/$UPD_LABEL" 2>/dev/null | sed -n 's/^[[:space:]]*state = /updater job: /p' | head -1
}

# Reinstalls a known version and proves it, so a failed rollback is never reported as a success.
restore_version() {
  local ver="$1" was_loaded="$2"
  npm_run install -g --prefix "$RUNTIME" --no-fund --no-audit "omniroute@$ver" || die "ROLLBACK FAILED: npm could not reinstall $ver (service left stopped; retry: omni-ctl.sh install $ver)"
  [ "$(pkg_version)" = "$ver" ] || die "ROLLBACK FAILED: package is $(pkg_version), expected $ver"
  if [ "$was_loaded" = 1 ]; then
    launchctl bootstrap "$DOMAIN" "$PLIST" || die "ROLLBACK FAILED: launchctl bootstrap"
    wait_ready 180 || die "ROLLBACK FAILED: $ver installed but not healthy, check: omni-ctl.sh logs"
  fi
}

cmd_update() {
  need_runtime
  pin_machine_salt   # must happen BEFORE the package (and its .env) is replaced
  local want="${1:-}" cur was_loaded=0
  cur="$(pkg_version)"
  if [ -z "$want" ]; then
    want="$(npm_run view omniroute version --prefer-online 2>/dev/null | tail -1)"
    [ -n "$want" ] || die "could not read the latest version from the npm registry"
  fi
  if [ "$want" = "$cur" ]; then say "already on $cur"; return 0; fi
  # Validate the target before anything is stopped, so a typo costs no downtime.
  npm_run view "omniroute@$want" version >/dev/null 2>&1 || die "omniroute@$want does not exist on the npm registry"
  say "updating omniroute $cur -> $want"
  # cmd_backup exits on failure, so run it in a subshell to reach the override hint.
  if [ "${OMNI_SKIP_BACKUP:-0}" != "1" ]; then ( cmd_backup ) || die "backup failed, aborting update (set OMNI_SKIP_BACKUP=1 to override)"; fi
  is_loaded && was_loaded=1
  [ "$was_loaded" = 1 ] && { unload 60 || die "service still shutting down, try again in a minute"; }
  if ! npm_run install -g --prefix "$RUNTIME" --no-fund --no-audit "omniroute@$want"; then
    warn "install failed, restoring $cur"
    restore_version "$cur" "$was_loaded"
    die "update to $want failed, back on $cur"
  fi
  [ "$was_loaded" = 1 ] && launchctl bootstrap "$DOMAIN" "$PLIST"
  if [ "$was_loaded" = 1 ] && ! wait_ready 180; then
    warn "server not healthy on $want, rolling back to $cur"
    unload 60 || warn "service still shutting down"
    restore_version "$cur" "$was_loaded"
    die "rolled back to $cur"
  fi
  say "ok: now on $(pkg_version). Desktop app update: omni-ctl.sh install-desktop $want"
}

# Official macOS arm64 build from the GitHub release, verified against the release's own sha512.
cmd_install_desktop() {
  local ver="${1:-$DEFAULT_VERSION}"
  local dir="$KIT/releases/v$ver" dmg="$KIT/releases/v$ver/OmniRoute-$ver-arm64.dmg"
  mkdir -p "$dir"
  if [ ! -f "$dmg" ] || [ ! -f "$dir/latest-mac.yml" ]; then
    command -v gh >/dev/null 2>&1 || die "gh CLI needed to download the release"
    ( cd "$dir" && gh release download "v$ver" -R diegosouzapw/OmniRoute -p "OmniRoute-$ver-arm64.dmg" -p latest-mac.yml --clobber ) || die "download failed"
  fi
  local want got
  want="$(awk -v f="OmniRoute-$ver-arm64.dmg" '$1=="-" && $2=="url:" {hit=($3==f)} hit && $1=="sha512:" {print $2; exit}' "$dir/latest-mac.yml")"
  got="$(openssl dgst -sha512 -binary "$dmg" | base64 | tr -d '\n')"
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    # Usually a half-finished earlier download: fetch both files once more and re-check.
    warn "sha512 mismatch, downloading v$ver again"
    ( cd "$dir" && gh release download "v$ver" -R diegosouzapw/OmniRoute -p "OmniRoute-$ver-arm64.dmg" -p latest-mac.yml --clobber ) || die "download failed"
    want="$(awk -v f="OmniRoute-$ver-arm64.dmg" '$1=="-" && $2=="url:" {hit=($3==f)} hit && $1=="sha512:" {print $2; exit}' "$dir/latest-mac.yml")"
    got="$(openssl dgst -sha512 -binary "$dmg" | base64 | tr -d '\n')"
    [ -n "$want" ] && [ "$want" = "$got" ] || die "sha512 mismatch for $dmg after a fresh download (expected '$want'), not installing"
  fi
  say "sha512 verified against latest-mac.yml"
  if pgrep -f "$APP/Contents/MacOS" >/dev/null 2>&1; then die "OmniRoute desktop is running, quit it first"; fi
  local mnt; mnt="$(mktemp -d /tmp/omniroute-dmg.XXXXXX)"
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$dmg" >/dev/null || { rmdir "$mnt"; die "cannot mount $dmg"; }
  if [ -d "$APP" ]; then rsync -a --delete "$mnt/OmniRoute.app/" "$APP/"; else ditto "$mnt/OmniRoute.app" "$APP"; fi
  local rc=$?
  hdiutil detach "$mnt" >/dev/null 2>&1; rmdir "$mnt" 2>/dev/null
  [ "$rc" = 0 ] || die "copy to $APP failed"
  # Upstream ships only an ad-hoc linker signature, so a "no resources" verify note is expected; anything else is worth a look.
  codesign --verify --deep "$APP" 2>&1 | grep -v -e "code has no resources but signature indicates they must be present" | head -3
  desktop_prefs
  say "desktop app installed: $APP ($(defaults read "$APP/Contents/Info" CFBundleShortVersionString))"
}

# Point the desktop shell at the always-on service instead of letting it start a second server.
# The app reads <its data dir>/electron-preferences.json; launched from Finder that dir is ~/.omniroute.
desktop_prefs() {
  local f="$HOME/.omniroute/electron-preferences.json"
  mkdir -p "$HOME/.omniroute"
  "$NODE_BIN" -e '
    const fs = require("fs"); const [f, u] = process.argv.slice(1);
    let p = {}; try { p = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    p.remoteServerUrl = u; fs.writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
  ' "$f" "$URL" && say "desktop shell -> $URL (prefs: $f)"
}

# Turns on the optional features this kit ships enabled. Idempotent. The server still binds loopback only and
# still requires an API key, so MCP and A2A are not reachable from the network.
#   MCP : /api/mcp/stream  (110 tools; needs a management-scoped key)
#   A2A : /a2a             (agent card at /.well-known/agent.json)
#   backup: official scheduled DB backup, daily 03:00, keep the last 14 (read at server start)
# Left OFF on purpose (they change model output, enable in the dashboard if wanted): compression modes.
cmd_features() {
  need_runtime
  ready || die "service is not running (omni-ctl.sh start)"
  run_cli_quiet mcp enable --transport streamable-http
  run_cli_quiet backup auto enable --cron "0 3 * * *" --retention 14
  # A2A has no CLI toggle; this is the settings endpoint the dashboard switch uses.
  env DATA_DIR="$DATA_DIR" OMNI_PKG="$PKG_DIR" OMNI_URL="$URL" "$NODE_BIN" --input-type=module -e '
    const { apiFetch } = await import(`file://${process.env.OMNI_PKG}/bin/cli/api.mjs`);
    const r = await apiFetch("/api/settings", { method: "PATCH", baseUrl: process.env.OMNI_URL, body: { a2aEnabled: true } });
    console.log(r.status === 200 ? "A2A enabled." : `A2A enable failed: HTTP ${r.status}`);
  ' 2>&1 | grep -v -E '^[[:space:]]+(📋|⚠)'
  say "restart to load the backup schedule: omni-ctl.sh restart"
}

# `omni-ctl.sh cli ...`: TTY kept for interactive commands (chat, setup); noise filtered when piped or captured.
cmd_cli() { if [ -t 1 ]; then run_cli "$@"; else run_cli_quiet "$@"; fi; }

# http://omni.local -> this service. Port 80 *:80 belongs to Local (Flywheel)'s router nginx, so omni.local
# gets its own loopback aliases (127.0.0.2, fd6f:6d6e::2) and a tiny TCP forwarder bound only there.
# macOS allows an unprivileged bind below 1024 only on the wildcard address, so the forwarder runs from the
# root LaunchDaemon com.nexalance.omni-local (it drops to "nobody" after binding). Root may not read the T7
# drive, so both files are staged on the internal disk and the root part runs from there via the macOS
# administrator password dialog.
OLD_PROXY_LABEL="com.nexalance.omniroute-hostproxy"   # first attempt (user agent, could not bind :80)
cmd_hostproxy() {
  local f
  for f in omni-local-proxy.mjs omni-local-root.sh; do
    [ -f "$KIT/scripts/$f" ] || die "missing $KIT/scripts/$f"
    cp "$KIT/scripts/$f" "$RUNTIME/$f"
  done
  if [ -f "$HOME/Library/LaunchAgents/$OLD_PROXY_LABEL.plist" ]; then
    launchctl bootout "$DOMAIN/$OLD_PROXY_LABEL" 2>/dev/null
    rm -f "$HOME/Library/LaunchAgents/$OLD_PROXY_LABEL.plist"
    say "removed the old user-level proxy agent"
  fi
  say "macOS will ask for your login password (root part: aliases, hosts entries, proxy daemon)"
  osascript -e "do shell script \"/bin/bash '$RUNTIME/omni-local-root.sh'\" with prompt \"OmniRoute: set up http://omni.local (hosts entries, loopback aliases, proxy daemon)\" with administrator privileges" \
    || die "root part not applied (dialog cancelled or failed)"
  local i; for i in 1 2 3 4 5 6 7 8 9 10; do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://omni.local/healthz)" = "200" ] && { say "ready: http://omni.local"; return 0; }
    sleep 2
  done
  warn "omni.local not answering yet, check: /Library/Logs/OmniRoute-Local/proxy.log"; return 1
}

cmd_uninstall() {
  cmd_disable
  [ -f "$PLIST" ] && rm -f "$PLIST" && say "removed $PLIST"
  cat <<EOF
Left in place on purpose (remove by hand only if you are sure):
  $RUNTIME      package install
  $DATA_DIR     database and secrets  (back up first: omni-ctl.sh backup --with-secrets)
  $APP          desktop app
  $KIT          this kit
EOF
}

usage() {
  cat <<EOF
omni-ctl.sh <command>
  status | start | stop | restart | health | logs [-f] | open | desktop
  enable | disable            auto-start at login on/off
  install [version]           install package + .env + LaunchAgent (default $DEFAULT_VERSION)
  install-desktop [version]   install the official desktop app and attach it to the service
  update | upgrade            pull the newest upstream release into the fork overlay, build, deploy, rebuild the desktop app
  build-only                  build + isolated smoke without changing the live service
  redeploy                    build + deploy the current nexalance commit (after a customization change)
  update-status               last update result (also shown as a macOS notification)
  updater-install             (re)install the updater LaunchAgent and the dashboard Update-button hook
  update-npm                  blocked: stock packages cannot preserve the verified Bridge
  backup [--with-secrets]     snapshot the database into $KIT/backups
  features                    enable MCP, A2A and the scheduled official backup
  hostproxy                   serve http://omni.local (asks for the macOS admin password once)
  cli <args...>               run the official omniroute CLI against this instance
  uninstall                   stop, drop the LaunchAgent plist, list what is left
EOF
}

case "${1:-help}" in
  install)
    [ ! -d "$RUNTIME/lib/node_modules/omniroute" ] || die "An installed runtime already exists. Use omni-ctl update or omni-ctl redeploy to preserve the verified overlay."
    shift; cmd_install "$@" ;;
  install-desktop) shift; cmd_install_desktop "$@" ;;
  enable) cmd_enable ;;
  disable) cmd_disable ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  health) cmd_health ;;
  logs) shift; cmd_logs "$@" ;;
  open) cmd_open ;;
  desktop) cmd_desktop_open ;;
  backup) shift; cmd_backup "$@" ;;
  update|upgrade) cmd_updater_run update ;;
  redeploy) cmd_updater_run redeploy ;;
  build-only) cmd_updater_run build-only ;;
  update-npm) die "Stock npm replacement would remove the native Bridge fixes. Use omni-ctl update or omni-ctl redeploy." ;;
  updater-install) cmd_updater_install ;;
  update-status) cmd_update_status ;;
  features) cmd_features ;;
  hostproxy) cmd_hostproxy ;;
  cli) shift; cmd_cli "$@" ;;
  uninstall) cmd_uninstall ;;
  help|-h|--help) usage ;;
  *) usage; exit 2 ;;
esac
