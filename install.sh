#!/bin/sh
set -eu
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
esac
URL="https://github.com/paire-dev/paire/releases/latest/download/paire-${OS}-${ARCH}"
DEST="${PAIRE_INSTALL:-$HOME/.paire/bin}"
mkdir -p "$DEST"
curl -fsSL "$URL" -o "$DEST/paire"
chmod +x "$DEST/paire"
echo "Installed to $DEST/paire"
echo "Add to PATH: export PATH=\"$DEST:\$PATH\""
