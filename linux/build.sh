#!/usr/bin/env bash
set -euo pipefail

ARCH="${1:-x64}"
case "$ARCH" in x64|arm64) ;; *) echo "usage: $0 [x64|arm64]" >&2; exit 2;; esac
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != Linux ]]; then
  echo "linux/build.sh must run on Linux." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(`.`)[0])' 2>/dev/null || echo 0)"
if (( NODE_MAJOR < 24 )); then
  echo "Node.js 24+ is required to build OneCode Linux (found: $(node --version 2>/dev/null || echo missing))." >&2
  exit 1
fi

npm ci
npm run verify:ci
node scripts/package.mjs --platform linux --arch "$ARCH"

echo "Linux $ARCH packages are under $ROOT/release/."
