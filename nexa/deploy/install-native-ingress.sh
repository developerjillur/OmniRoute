#!/bin/bash
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run with sudo; enter the Mac password in Terminal only.'; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$HERE/native-ingress.mjs"
APPDIR='/Library/Application Support/OmniRoute-Native-Ingress'
LABEL=com.nexalance.omniroute-native-ingress
PLIST="/Library/LaunchDaemons/$LABEL.plist"
STAMP="$(date +%Y%m%d-%H%M%S)"
[ -f "$SOURCE" ] && [ -x /usr/local/bin/node ]
mkdir -p "$APPDIR" /Library/Logs/OmniRoute-Local
# Retain every prior install; never delete a certificate, hosts entry or user file.
[ ! -f "$APPDIR/native-ingress.mjs" ] || cp -p "$APPDIR/native-ingress.mjs" "$APPDIR/native-ingress-$STAMP.mjs"
[ ! -f "$PLIST" ] || cp -p "$PLIST" "$APPDIR/daemon-$STAMP.plist"
install -o root -g wheel -m 644 "$SOURCE" "$APPDIR/native-ingress.mjs"
cat > "$PLIST" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string>$APPDIR/native-ingress.mjs</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>/Library/Logs/OmniRoute-Local/native-ingress.log</string>
<key>StandardErrorPath</key><string>/Library/Logs/OmniRoute-Local/native-ingress.log</string>
</dict></plist>
XML
chown root:wheel "$APPDIR" "$PLIST"; chmod 755 "$APPDIR"; chmod 644 "$PLIST"
plutil -lint "$PLIST"
MODE=reload
if cmp -s "$APPDIR/native-ingress-$STAMP.mjs" "$SOURCE" && cmp -s "$APPDIR/daemon-$STAMP.plist" "$PLIST"; then MODE=keep; fi
/bin/bash "$HERE/bootstrap-launchdaemon.sh" "$LABEL" "$PLIST" "$MODE"
echo 'Native HTTPS ingress installed. Binds loopback only, then runs as nobody. No hosts or trust settings changed.'
