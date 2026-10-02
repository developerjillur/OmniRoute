#!/bin/bash
set -euo pipefail
LABEL="${1:?daemon label required}"
PLIST="${2:?daemon plist required}"
TARGET="system/$LABEL"
MODE="${3:-reload}"
if [ "$MODE" = keep ] && launchctl print "$TARGET" >/dev/null 2>&1; then
  echo "Native ingress LaunchDaemon already loaded; no interruption."
  exit 0
fi
if launchctl print "$TARGET" >/dev/null 2>&1; then
  launchctl bootout "$TARGET"
  WAITED=0
  while launchctl print "$TARGET" >/dev/null 2>&1; do
    [ "$WAITED" -lt 30 ] || { echo "Previous daemon teardown did not finish; no duplicate bootstrap attempted." >&2; exit 1; }
    sleep 1
    WAITED=$((WAITED+1))
  done
fi
launchctl enable "$TARGET"
ATTEMPT=0
while [ "$ATTEMPT" -lt 5 ]; do
  if launchctl bootstrap system "$PLIST"; then
    break
  fi
  # launchd may complete registration despite a transient bootstrap response.
  if launchctl print "$TARGET" >/dev/null 2>&1; then
    break
  fi
  ATTEMPT=$((ATTEMPT+1))
  [ "$ATTEMPT" -lt 5 ] || break
  sleep 1
done
launchctl print "$TARGET" >/dev/null 2>&1 || { echo "Native ingress daemon could not be loaded; inspect launchd diagnostics." >&2; exit 1; }
echo 'Native ingress LaunchDaemon loaded.'
