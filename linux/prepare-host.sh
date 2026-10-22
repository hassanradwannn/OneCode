#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION="v24.22.0"
NODE_ARCH="x64"
NODE_SHA256="cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008"
NODE_ROOT="$HOME/.local/opt/node-${NODE_VERSION}-linux-${NODE_ARCH}"
CACHE="$HOME/.cache/onecode-linux"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo "This preparation script currently targets Linux x86_64." >&2
  exit 1
fi

if [[ ! -x "$NODE_ROOT/bin/node" ]]; then
  mkdir -p "$HOME/.local/opt" "$CACHE"
  archive="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${archive}" -o "$CACHE/$archive"
  printf '%s  %s\n' "$NODE_SHA256" "$CACHE/$archive" | sha256sum -c -
  rm -rf "$NODE_ROOT.stage"
  mkdir -p "$NODE_ROOT.stage"
  tar -xJf "$CACHE/$archive" --strip-components=1 -C "$NODE_ROOT.stage"
  mv "$NODE_ROOT.stage" "$NODE_ROOT"
fi

"$NODE_ROOT/bin/node" --version
"$NODE_ROOT/bin/node" "$NODE_ROOT/lib/node_modules/npm/bin/npm-cli.js" --version
"$NODE_ROOT/bin/node" "$ROOT/scripts/fetch-linux-dictation-runtime.mjs" --platform linux --arch x64
if ! command -v parec >/dev/null 2>&1; then
  echo "Linux dictation still needs the host PulseAudio/PipeWire client (parec); install pulseaudio-utils explicitly." >&2
fi
if python3 -S "$ROOT/linux/dictation.py" --runtime-root "$ROOT/resources/packaging/dictation/linux/x64" --check; then
  echo "Linux dictation dependencies: ready"
else
  echo "Linux dictation host prerequisites are not ready yet; no system packages were changed." >&2
fi

cat <<EOF
Prepared Ubuntu build host.
Use this Node toolchain for the current shell:
  export PATH="$NODE_ROOT/bin:\$PATH"
EOF
