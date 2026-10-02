#!/bin/bash
# Preserve the existing command and install the versioned local update entry point.
set -euo pipefail
TOOLS="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/.local/bin/omni-ctl"
BACKUP="$TARGET.before-bridge-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$HOME/.local/bin"
echo "Source: $TOOLS/omni-ctl.sh"
echo "Target: $TARGET"
echo "Preserved prior command: $BACKUP"
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  [ ! -e "$BACKUP" ] && [ ! -L "$BACKUP" ]
  mv "$TARGET" "$BACKUP"
fi
cp "$TOOLS/omni-ctl.sh" "$TARGET"
chmod 755 "$TARGET"
bash -n "$TARGET"
echo "Versioned OmniRoute command installed"
