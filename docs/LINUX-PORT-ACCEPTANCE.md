# Linux port acceptance and issue log

Validated on 2026-10-22 against Ubuntu 22.04.5 LTS, kernel 6.8, x86_64, GNOME on X11, Tailscale 1.104.1 and OneCode 0.4.8 on the `linux` branch.

This file records the Linux-specific failures found during live acceptance, the actual root causes, the repairs, and the remaining platform boundaries. It intentionally omits connector secrets, account material and private Funnel URLs.

## 1. Tailscale looked signed in but route mutation was denied

**Observed:** Tailscale CLI/version and account checks passed, while Connect failed at the first Serve/Funnel mutation with a permission error.

**Root cause:** Linux Tailscale had no daemon operator configured. Read-only commands such as `tailscale status --json` and Funnel status worked for the desktop user, but Serve/Funnel mutations did not.

**Repair:** Linux now preflights `tailscale get operator` before custody persistence or route mutation. If the current desktop user is not the operator, OneCode reports the operator prerequisite and uses a polkit-visible `pkexec tailscale set --operator=<user>` action. It does not call `tailscale up`, use an auth key, or mutate a Funnel route until the operator recheck succeeds.

**Live result:** the operator became the desktop user and OneCode proceeded into route publication without a global Tailscale reset or unrelated route changes.

## 2. “Allow OneCode to use Tailscale” opened documentation instead of authorizing

**Observed:** clicking the setup button opened a browser page and performed no Linux authorization.

**Root cause:** both the main setup card and Remote settings were wired directly to the setup action URL instead of the trusted main-process setup launcher.

**Repair:** the renderer now calls a dedicated IPC setup action. Operator authorization never falls back to documentation, cancelled polkit prompts can be explicitly retried by the user, and background polling does not repeatedly spawn prompts.

## 3. OneCode opened Firefox even when Brave was selected

**Observed:** the saved OneCode browser preference was Brave, but setup/provider/help links opened Firefox, the Ubuntu OS default.

**Root cause:** generic `link:open` routing used Electron `shell.openExternal` for ordinary HTTPS links unless the embedded COS browser was selected. A concrete Brave/Chrome/Edge/Firefox preference therefore had no effect on most non-chat web links.

**Repair:** ordinary HTTP/HTTPS links now use `openInPreferredBrowser(..., { reveal: true })` whenever a concrete native browser is selected. `external: true` retains its original meaning only for COS: escape the embedded browser to the OS handler. Non-web schemes such as `mailto:` still use the OS handler.

## 4. Existing Linux config advertised the same connector name as Windows

**Observed:** the existing Linux config contained an empty `connectorSuffix`, producing historical unsuffixed names such as `OneCode Core` and colliding conceptually with an unsuffixed Windows device.

**Root cause:** connector naming was platform-neutral and treated a blank stored suffix as intentional plain naming on every platform.

**Repair:** Linux uses `Linux` as the runtime fallback when the stored suffix is blank/invalid, while an explicit user suffix still wins. Fresh Linux defaults also store `connectorSuffix: "Linux"`. Windows historical unsuffixed naming remains unchanged.

**Expected Linux identities:** `OneCode Core Linux`, `OneCode Desktop Linux`, and `OneCode Plugins Linux` unless the user configured another suffix.

## 5. Public probe crashed the Electron main process on IPv6-unreachable hosts

**Observed:** after Funnel route publication, Electron showed an uncaught main-process exception similar to `connect ENETUNREACH <IPv6>:443`.

**Root cause:** OneCode intentionally races public A and AAAA ingress addresses, but its forced-address DNS `lookup` callback returned synchronously. Node could begin `connect()` to an unreachable IPv6 route before the request error listener was attached, allowing the immediate `ENETUNREACH` to escape.

**Repair:** the forced lookup callback is deferred with `queueMicrotask`, matching the asynchronous `dns.lookup` contract. A dead address family is now a normal transport failure while the other family keeps racing; IPv6 was not disabled.

**Live result:** the Legion has working public IPv4 and no usable IPv6 route. All tested public IPv4 ingress addresses completed TCP 443 and TLS 1.3; IPv6 returned network-unreachable. The rebuilt app no longer crashed, reached metadata HTTP 200 and MCP initialize HTTP 200, and transitioned to public `ready`.

## 6. First public retry could report a transient TLS error before recovery

**Observed:** immediately after route publication the first bounded public check reported `tls-error`.

**Evidence:** later retries reached OneCode's metadata and MCP endpoints successfully and the connection became ready without changing the Funnel route.

**Conclusion:** the state machine correctly retained the owned route and retried verification. A transient first failure is not treated as authority to replay route mutation.

## 7. Ubuntu system Node/npm were too old for the build scripts

**Observed:** the distro supplied Node 12.22.9. Build commands launched with the wrong nested runtime failed on modern JavaScript syntax, and one mixed Node/npm attempt loaded Ubuntu's old npm modules under Node 24.

**Repair/acceptance rule:** Linux packaging stages and uses the verified private Node 24.22.0 + npm 11.19.1 runtime. For nested build scripts, the packaged Node/npm bin directory must lead `PATH`; do not replace Ubuntu's system Node globally just to build OneCode.

## 8. Linux packaging worked, but full package rebuilds were expensive for tiny app-layer fixes

AppImage and DEB packaging, native payload staging and packaged-runtime smoke all succeeded on the Legion. The full AppImage/DEB path is still the release path when native/package contents change.

For app-layer-only Linux acceptance, prefer `dist:dir:linux:x64` and the unpacked runtime instead of repeatedly rebuilding/compressing the AppImage and DEB. This avoids another full artifact transfer while exercising the packaged application layer.

The published application-capsule updater documented in `HOTFIX-UPDATES.md` is currently Windows-only: its runtime fingerprint, manifest contract, detached activation helper and publisher are explicitly `win32`. Do not claim that the existing Windows hotfix capsule can patch an AppImage in place. A true persistent Linux application capsule would need its own writable activation target and rollback design; AppImage's SquashFS payload is immutable.

## 9. Local Linux packaging regenerated third-party notices

The Linux checkout already had a tracked `THIRD-PARTY-NOTICES.txt` modification caused by target-specific package notice generation. Acceptance preserved that exact local file across builds instead of resetting or committing it accidentally.

## 10. The Windows workspace intentionally contains untracked acceptance helpers

The canonical workspace has numerous local untracked release/acceptance scripts and `tmp/`. Linux work must not use `git clean`, hard reset, or broad staging. Each Linux fix was committed/staged only from its intended source files.

## 11. Test-tree caveat

The local workspace's `/test/` tree is ignored by Git. Focused regression edits can still be run locally, but they are not force-added merely to make a patch look larger. Source behavior must pass focused tests, TypeScript and whitespace checks before staging.

## 12. ChatGPT opened correctly but OneCode refused to submit the task

**Observed:** the hotfixed browser routing opened the selected Brave profile and ChatGPT showed `OneCode Core Linux` in Plugins, but an app-authored task stopped before Send with: “The current OneCode Core connector is not available in this ChatGPT account.” Nothing was submitted.

**Root cause:** Linux MCP naming and the setup UI used the platform-aware blank-suffix fallback (`Linux`), but the browser bridge still handed the extension `connectorNames(getConfig().connectorSuffix)` directly. On an existing Linux config whose stored suffix was blank, the bridge therefore told the extension to look for `OneCode Core` while the live MCP server and ChatGPT correctly called it `OneCode Core Linux`.

**Repair:** the bridge now publishes the exact configured Core/Desktop/Plugins names from the same owner used by the MCP server. The browser extension no longer substitutes a plain default, a remembered Core from another tab, a learned provider rename, a legacy connector alias, or an app ID whose visible name differs. Provider app IDs may be retained as metadata, but they are not connector-name authority.

## 13. Setup said the provider could not edit files or run commands

**Observed:** Ready showed “Provider can't edit files or run commands” even though the tunnel and Core plugin were connected.

**Root cause:** this was real saved authority, not a Linux projection error. The Legion config had `readOnly: false`, but only the `read` capability was enabled; `create`, `edit`, `move`, `deleteFile` and `command` were off. Connection readiness does not widen local permissions.

**Repair/acceptance rule:** when the user wants normal coding work, choose **Files and terminal** (or explicitly enable the equivalent Workspace permissions). This grants file mutation and command execution without pretending Linux has OneCode's Windows/macOS native desktop backend. Full desktop automation remains a separate Linux/CUA concern.

## 14. Connector identity must have one authority and no naming fallbacks

The connector name shown/configured by OneCode is the only name the browser bridge, provider adapters and MCP presentation may accept for that surface. This is a cross-platform invariant, not a Linux special case.

Forbidden fallbacks include:

- assuming plain `OneCode Core` / `Desktop` / `Plugins` before the app has supplied its current names;
- accepting a provider-side rename merely because an old app ID was previously proven;
- remembering a Core from another browser tab and using it before the current page lists the exact configured name;
- legacy connector aliases such as pre-split names;
- fuzzy case/space/hyphen normalization that turns a different provider label into the configured connector;
- using a stored app ID, link ID or prior request as permission to override a visible name mismatch.

The provider page may supply an app ID/path *after* the exact configured name matches, so OneCode can address that exact row. The ID is routing/evidence, not a second naming authority. If the exact current name is absent or ambiguous, OneCode must refuse the send and explain that the current connector must be connected under the name shown in Setup.

## Windows installer regression checklist

Use the failures in this document as an acceptance suite for the next Windows installer/full-release check. A clean install and an upgrade from an older supported build should both be exercised; do not validate only a development checkout.

1. **Connector name continuity:** record the names shown by OneCode Setup, then verify the MCP `initialize` identity, protected-resource metadata, bridge `/status`, ChatGPT/Gemini adapter state and provider plugin list all use exactly those names. Change the suffix and repeat. No component may silently retain the old/plain name.
2. **No provider-name fallback:** with the current connector temporarily absent, renamed in the provider, duplicated, or replaced by a different app ID, an app-authored send must refuse before Send rather than selecting a remembered/legacy/ID-only match. Restore the exact configured name and verify send succeeds.
3. **Browser preference ownership:** select Brave/Chrome/Edge/Firefox and exercise Setup links, provider Plugins links, Tailscale/help links and generic HTTPS links. They must open in the selected browser; `shell.openExternal`/the OS default must not override a concrete OneCode browser choice.
4. **Setup actions versus help URLs:** an action such as Tailscale authorization must invoke its native setup owner. A help/documentation URL must never stand in for the action simply because setup failed or was cancelled.
5. **Permission persistence:** verify the installer/upgrade preserves `readOnly`, roots and each capability exactly. A working tunnel must not imply write authority, and an upgrade must not unexpectedly collapse Files/Terminal permissions to read-only or widen them to full access.
6. **Public probe resilience:** test a host with unusable IPv6 but working IPv4. The main process must not crash on immediate `ENETUNREACH`; IPv4 must continue and a transient first probe must not trigger uncertain Funnel/route mutation replay.
7. **Tunnel custody safety:** reconnect, restart and uninstall/reinstall scenarios must touch only OneCode-owned Serve/Funnel routes. Never global-reset Tailscale or overwrite unrelated routes because verification is slow or ambiguous.
8. **Runtime isolation:** verify packaged Node/npm and native modules are the versions shipped by OneCode and do not accidentally resolve an older system Node/npm. Nested scripts/plugins must inherit the private runtime correctly.
9. **Browser companion/profile continuity:** after install/upgrade, the selected browser profile must still contain/connect the companion, and OneCode must not open a second browser/profile merely to recover automation.
10. **App-layer hotfix retention:** a full Windows installer produced after these fixes must contain the current application snapshot rather than reverting to an earlier app.asar. Then apply a compatible hotfix and verify the native base receipt remains correct while the app version advances.
11. **Config migration:** test a historical config with an empty connector suffix, a valid custom suffix, and a malformed/corrupt config. Migration must preserve user choices where trusted, use the platform's documented current default only where intended, and never invent a connector identity different from the one Setup displays.
12. **Installer-generated artifacts:** verify notices, extension assets, bundled skills, updater helpers and packaged runtime inventory correspond to the target platform and that target-specific generation does not accidentally dirty or overwrite unrelated source state.
13. **End-to-end provider acceptance:** from the installed build, open the configured provider, submit a OneCode-authored test message, observe the exact connector mention, execute one harmless read tool and one explicitly authorized file/command action, and verify the request reached the intended physical machine.

Any Windows failure matching one of the Linux incidents should be fixed in the shared owner rather than hidden behind a platform-specific workaround unless the underlying OS capability is genuinely different.

## Live acceptance reached

- Ubuntu app launched in the real GNOME/X11 user session.
- Linux Tailscale operator authorization completed through the desktop flow.
- Owned Funnel routes were published without resetting unrelated Tailscale state.
- The IPv6-unreachable main-process crash was reproduced, fixed, rebuilt and re-tested.
- Public metadata and MCP initialize requests returned HTTP 200 after retry.
- Connection reached public `ready` and remained alive across subsequent probes.
- Existing blank connector suffix is handled by the Linux identity fallback.
- Browser routing repair is app-layer only and can be tested through the Linux directory/hotfix-style build without another AppImage/DEB repack.
- The browser bridge and MCP server use the same platform-aware Linux connector identity, so ChatGPT can select `OneCode Core Linux` for app-authored sends.
- File/terminal edit authority remains an explicit user permission and is not inferred from a successful tunnel connection.

## Remaining Linux parity gates

The tunnel/MCP transport is no longer the primary Linux blocker. Remaining parity work should continue separately for start-at-login behavior, manual browser executable selection if still Windows-only, current dictation acceptance, CUA Driver installation/use, packaged plugin Node/npm selection, clean-install/DEB acceptance and AppImage self-update acceptance.
