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
dpkg-deb --contents "$DEB" | grep -q '/usr/bin/onecode\|/opt/OneCode/onecode'

if python3 linux/dictation.py --check >/dev/null 2>&1; then
  echo "Linux dictation dependencies: ready"
else
  echo "Linux dictation dependencies: not installed (AppImage will show an actionable error; DEB installs them)."
fi

echo "Packaged Linux $ARCH resource/runtime acceptance passed. Interactive GUI/provider/CUA tests remain."
