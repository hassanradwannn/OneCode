#!/usr/bin/env bash
set -euo pipefail

ARCH="${1:-x64}"
case "$ARCH" in x64|arm64) ;; *) echo "usage: $0 [x64|arm64]" >&2; exit 2;; esac
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node scripts/smoke-packaged-runtime.mjs --platform linux --arch "$ARCH"

APPIMAGE="release/OneCode-Linux-${ARCH}.AppImage"
DEB="release/OneCode-Linux-${ARCH}.deb"
test -f "$APPIMAGE" || { echo "Missing $APPIMAGE" >&2; exit 1; }
test -f "$DEB" || { echo "Missing $DEB" >&2; exit 1; }
test -x "$APPIMAGE" || chmod +x "$APPIMAGE"
dpkg-deb --info "$DEB" >/dev/null
# Do not use grep -q under pipefail here: an early match closes the pipe and makes dpkg-deb's
# tar child exit on SIGPIPE even though the package is valid. Consume the complete listing.
dpkg-deb --contents "$DEB" | grep -E '/usr/bin/onecode|/opt/OneCode/onecode' >/dev/null

echo "Packaged Linux $ARCH resource/runtime acceptance passed. Interactive GUI/provider/CUA tests remain."
