#!/usr/bin/env bash
set -euo pipefail

SOURCE="${1:-}"
if [[ -z "$SOURCE" || ! -f "$SOURCE" ]]; then
  echo "usage: $0 /path/to/OneCode-Linux-<arch>.AppImage" >&2
  exit 2
fi
SOURCE="$(readlink -f "$SOURCE")"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/onecode"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"
BIN_DIR="$HOME/.local/bin"
TARGET="$INSTALL_DIR/OneCode.AppImage"

mkdir -p "$INSTALL_DIR" "$APP_DIR" "$ICON_DIR" "$BIN_DIR"
cp "$SOURCE" "$TARGET.new"
chmod 0755 "$TARGET.new"
mv -f "$TARGET.new" "$TARGET"

if [[ -f "$ROOT/build/icon.png" ]]; then
  cp "$ROOT/build/icon.png" "$ICON_DIR/onecode.png.new"
  mv -f "$ICON_DIR/onecode.png.new" "$ICON_DIR/onecode.png"
fi

cat >"$APP_DIR/io.onecode.desktop.desktop.new" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=OneCode
Comment=Desktop workspace for AI providers and local tools
Exec="$TARGET"
Icon=onecode
Terminal=false
Categories=Development;
StartupNotify=true
EOF
mv -f "$APP_DIR/io.onecode.desktop.desktop.new" "$APP_DIR/io.onecode.desktop.desktop"
ln -sfn "$TARGET" "$BIN_DIR/onecode"

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
echo "Installed OneCode AppImage at $TARGET"
echo "Launcher: $APP_DIR/io.onecode.desktop.desktop"
echo "CLI symlink: $BIN_DIR/onecode"
