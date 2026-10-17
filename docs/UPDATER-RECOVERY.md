# OneCode 0.2.8.5 recovery

The laptop's failed 0.2.7 → 0.2.8 update installed the published executable correctly
but never restarted it. Its log ended at the old updater's shutdown handoff. Starting
the exact installed executable restored the existing four-session profile.

## Release identity and compatibility

The public release is named **OneCode v0.2.8.5**. Windows ProductVersion and FileVersion
are `0.2.8.5`; the app's update UI and companion's version name show that identity.
The package, companion protocol version field, GitHub compatibility release tag and
update manifest use **0.2.805** (`v0.2.805`). This valid three-part SemVer is deliberately
newer than 0.2.8 and accepted by the parser already shipped in 0.2.8. A four-part latest
tag would be invisible to that installed updater. Future releases must sort after
0.2.805 (for example 0.2.806 or 0.3.0).

## Update ownership

Only explicit, version-bound Update and restart requests enter the final shutdown
handoff. Ordinary Quit and staged downloads do not grant installation authority.
The handoff is atomically saved with the target version, installer digest, exact
registered target, original PID, executable and startup-log path. It contains no user
content or credentials.

A cache copy of the bundled Node runtime and the shipped bootstrap outlive Electron.
The helper waits for all old processes at that exact executable path, rechecks the
registration and digest, waits for the installer, verifies the installed Windows
version and registration, and launches the exact executable. NSIS `/D` stays final
and unquoted, including custom folders containing spaces. The helper does not use
`--force-run`. It checks for an existing successor and requires a surviving process
plus a fresh normal window-loaded log entry. The retired success receipt and bounded
bootstrap log remain under the app's updates cache. Failures remain as diagnostics;
startup can surface them but never retries installation automatically.

The installer includes a separate bounded restart observer for old updaters that
still invoke `--force-run`. It waits for NSIS to exit, validates the registered target
and expected version, and starts the exact app only if NSIS did not leave it running.

## Provider correction

The settings IPC merge previously omitted `ui.chatProvider`, silently discarding a
selection while the focused dropdown retained its unsaved display. Both selectors
now use the durable settings owner, and stale cosmetic saves preserve the selected
provider. Setup text, native connector instructions, screenshots, browser labels and
Gemini-only skill controls follow the selected provider. Model catalogs and login
evidence are provider-bound; a retired discovery nonce cannot populate another
provider's picker. Existing conversation identities retain their original routing.

## Verification

Focused updater/provider tests, the real settings IPC channel, a complete production
Electron-renderer switching test, TypeScript, package isolation and packaged native
runtime smoke are required. Prepublication integration uses the actual installed
0.2.8 updater with a private candidate metadata/download fixture; its production
digest, registration, staging, explicit UI install and installer behavior remain real.
This fixture is not evidence of a public GitHub network download. Public metadata and
asset hashes are verified separately after publication.
