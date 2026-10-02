#!/bin/bash
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run with sudo; enter the Mac password in Terminal only.'; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$HERE/native-ingress.mjs"
BINDER="$HERE/omni-bind.pl"
OWNER="${1:-${SUDO_USER:-$(stat -f %Su /dev/console)}}"
[[ "$OWNER" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || { echo 'Pass the non-root Local application username as the first argument.' >&2; exit 1; }
OWNER_UID="$(id -u "$OWNER")"
[ "$OWNER_UID" != 0 ] || { echo 'Socket owner must be the non-root Local application user.' >&2; exit 1; }
APPDIR='/Library/Application Support/OmniRoute-Native-Ingress'
LABEL=com.nexalance.omniroute-native-ingress
PLIST="/Library/LaunchDaemons/$LABEL.plist"
STAMP="$(date +%Y%m%d-%H%M%S)"
[ -f "$SOURCE" ] && [ -f "$BINDER" ] && [ -x /usr/local/bin/node ]
/usr/local/bin/node --check "$SOURCE"
/usr/bin/perl -c "$BINDER"
mkdir -p "$APPDIR" /Library/Logs/OmniRoute-Local
# Retain every prior install; never delete a certificate, hosts entry or user file.
[ ! -f "$APPDIR/native-ingress.mjs" ] || cp -p "$APPDIR/native-ingress.mjs" "$APPDIR/native-ingress-$STAMP.mjs"
[ ! -f "$PLIST" ] || cp -p "$PLIST" "$APPDIR/daemon-$STAMP.plist"
[ ! -f "$APPDIR/omni-bind.pl" ] || cp -p "$APPDIR/omni-bind.pl" "$APPDIR/omni-bind-$STAMP.pl"
install -o root -g wheel -m 644 "$SOURCE" "$APPDIR/native-ingress.mjs"
install -o root -g wheel -m 644 "$BINDER" "$APPDIR/omni-bind.pl"
cat > "$PLIST" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>/usr/bin/perl</string><string>$APPDIR/omni-bind.pl</string><string>$OWNER</string><string>127.0.0.1:443,[::1]:443</string><string>--</string><string>/usr/local/bin/node</string><string>$APPDIR/native-ingress.mjs</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>/Library/Logs/OmniRoute-Local/native-ingress.log</string>
<key>StandardErrorPath</key><string>/Library/Logs/OmniRoute-Local/native-ingress.log</string>
</dict></plist>
XML
chown root:wheel "$APPDIR" "$PLIST"; chmod 755 "$APPDIR"; chmod 644 "$PLIST"
plutil -lint "$PLIST"
MODE=reload
if cmp -s "$APPDIR/native-ingress-$STAMP.mjs" "$SOURCE" && cmp -s "$APPDIR/omni-bind-$STAMP.pl" "$BINDER" && cmp -s "$APPDIR/daemon-$STAMP.plist" "$PLIST"; then MODE=keep; fi
/bin/bash "$HERE/bootstrap-launchdaemon.sh" "$LABEL" "$PLIST" "$MODE"
# macOS may retain the public vendor address across a listener transition.
/usr/local/bin/node "$HERE/refresh-native-dns.mjs" --repair-if-enabled
echo 'Native HTTPS ingress installed. Local-user-owned loopback sockets; runs as nobody. No hosts or trust settings changed.'
