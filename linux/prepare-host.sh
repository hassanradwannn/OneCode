#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION="v24.22.0"
NODE_ARCH="x64"
NODE_SHA256="cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008"
NODE_ROOT="$HOME/.local/opt/node-${NODE_VERSION}-linux-${NODE_ARCH}"
CACHE="$HOME/.cache/onecode-linux"

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

if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  sudo -n apt-get install -y python3-pocketsphinx pocketsphinx-en-us pulseaudio-utils
else
  echo "Dictation prerequisites need installation: pulseaudio-utils python3-pocketsphinx pocketsphinx-en-us" >&2
  echo "Install them with your system package manager before microphone acceptance." >&2
fi

"$NODE_ROOT/bin/node" --version
"$NODE_ROOT/bin/node" "$NODE_ROOT/lib/node_modules/npm/bin/npm-cli.js" --version
if python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dictation.py" --check; then
  echo "Linux dictation dependencies: ready"
else
  echo "Linux dictation dependencies are not ready yet; this does not block the application build." >&2
fi

cat <<EOF
Prepared Ubuntu build host.
Use this Node toolchain for the current shell:
  export PATH="$NODE_ROOT/bin:\$PATH"
EOF
