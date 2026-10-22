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

## Live acceptance reached

- Ubuntu app launched in the real GNOME/X11 user session.
- Linux Tailscale operator authorization completed through the desktop flow.
- Owned Funnel routes were published without resetting unrelated Tailscale state.
- The IPv6-unreachable main-process crash was reproduced, fixed, rebuilt and re-tested.
- Public metadata and MCP initialize requests returned HTTP 200 after retry.
- Connection reached public `ready` and remained alive across subsequent probes.
- Existing blank connector suffix is handled by the Linux identity fallback.
- Browser routing repair is app-layer only and can be tested through the Linux directory/hotfix-style build without another AppImage/DEB repack.

## Remaining Linux parity gates

The tunnel/MCP transport is no longer the primary Linux blocker. Remaining parity work should continue separately for start-at-login behavior, manual browser executable selection if still Windows-only, current dictation acceptance, CUA Driver installation/use, packaged plugin Node/npm selection, clean-install/DEB acceptance and AppImage self-update acceptance.
