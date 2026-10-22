# OneCode Linux port

This directory contains Linux-only integration and acceptance assets. The application remains a
single cross-platform source tree; Linux-specific runtime owners are wired from `src/main/linux/`
instead of forking the renderer, bridge, MCP server or provider adapters.

## Supported test target

- Ubuntu 22.04 LTS x86_64 (GNOME/X11 is the primary acceptance machine)
- Electron's existing Linux packages: AppImage and `.deb`
- Node.js 24 is required to build. The packaged application carries its own checksum-pinned Node
  24/npm runtime for npm plugins, so the user's system Node version does not control plugin support.

Build and run the native package gate:

```bash
bash linux/build.sh x64
bash linux/acceptance.sh x64
```

The AppImage can be installed per-user without root:

```bash
bash linux/install-appimage.sh release/OneCode-Linux-x64.AppImage
```

The `.deb` is the system-package installer and is built alongside the AppImage.

## Linux-specific features

### Start at login

The setting writes only OneCode's XDG autostart entry under
`$XDG_CONFIG_HOME/autostart/io.onecode.desktop.desktop` (or `~/.config/autostart`). AppImage
launches use the stable `$APPIMAGE` path rather than Electron's temporary `/tmp/.mount_*` path.

### Browser executable selection

Chrome/Chromium, Edge, Brave and Firefox can be selected manually when automatic distro/Snap/
Flatpak discovery is insufficient. The picker accepts only an absolute executable whose basename
matches the selected browser family.

### Computer use

OneCode's reviewed CUA Driver plugin already has a Unix installer/daemon path. Linux acceptance
uses that plugin for computer use rather than pretending the Windows UI Automation backend exists
on Linux.

### Dictation

The first Linux backend is deliberately **basic offline English dictation**. It uses `parec` to
stream 16 kHz mono PCM directly into PocketSphinx in memory. Audio is never written to disk,
logged, uploaded or sent through Electron IPC; only transcript/status JSON reaches OneCode.

Ubuntu 22.04 packages:

```bash
sudo apt install pulseaudio-utils python3-pocketsphinx pocketsphinx-en-us
```

The `.deb` declares these packages. AppImage users who do not have them receive an actionable
error when they click the microphone. PocketSphinx is materially less accurate than the modern
Windows recognizer and does not provide comparable punctuation or multilingual coverage. A future
production-quality backend should reuse this same local PCM/JSON lifecycle with a checksum-verified
local Whisper-class runtime/model rather than sending microphone audio to a cloud API.

The helper can be checked without opening the microphone:

```bash
python3 linux/dictation.py --check
```

For a manual microphone test, choose a unique stop file, start the helper, speak English, then
create the stop file. The final phrase should be emitted before `status: stopped`, and no `parec`
process should remain.

## Acceptance boundary

`linux/acceptance.sh` proves packaged resources and native modules. Signed-in ChatGPT/Gemini,
CUA desktop control, tray/notification behavior, microphone audio, and window/session behavior are
interactive acceptance items and must be exercised on the real Linux desktop before a Linux build
is called release-ready.
