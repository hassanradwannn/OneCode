# OneCode Linux port and cross-platform release handoff

Last updated: 2026-10-22
Source branch: `linux`
Application version: `0.4.8`
Latest source commits at this handoff:

- `fcf5d3e Preserve shell lifecycle during transcript recovery`
- `b62a633 Align Companion display version`
- `67b4ba0 Stabilize Tailscale health and shell transcript`
- `fd6a53b Handle unreachable IPv6 public probes`
- `1582249 Honor configured browser for web links`
- `ca7dbab Enforce exact connector identity`

This document is the engineering handoff for the Linux port and the regression checklist for the Windows installer. It records the failures found during real Ubuntu acceptance, the user's non-negotiable rules, the fixes already made, the tests/live evidence used, and the release/hotfix procedures for both platforms.

It intentionally contains no connector secret URLs, session credentials, browser profile data, Tailscale auth material or private conversation text.

## 1. User requirements that override convenience fallbacks

### Connector identity: exact name only

There are **no connector-name fallbacks**.

The single naming authority is the exact current connector name that OneCode itself is configured to advertise. Provider-side discovery, the browser Companion, native mentions, tool attribution and setup status must all use that exact name.

Do not accept any of these as substitutes:

- the historical plain `OneCode Core` when this device advertises another name;
- a platform guess;
- a remembered connector from another tab or earlier run;
- a provider-side rename or normalized alias;
- a legacy connector name;
- an app ID whose visible name no longer equals OneCode's current name;
- a case/dash/spacing transformation that the provider happens to render differently.

An app ID may corroborate an **already exact-name-matched** connector. It may not replace the exact-name requirement. If the exact current name is absent or ambiguous, fail closed and tell the user to connect the current Core URL/name.

This rule exists because one ChatGPT/Gemini account can contain connectors from several computers. A permissive fallback can silently route work to the wrong physical machine.

### Linux desktop automation

Do not fake native Linux desktop automation by setting `desktopAutomationSupported('linux')` to true. The built-in native desktop registrars are Windows/macOS-specific. Linux computer use is currently intended to come through the CUA Driver plugin exposed by Core's `plugins` gateway.

### Tailscale route ownership

Never reset Tailscale globally, overwrite unrelated Serve/Funnel routes or blindly replay an ambiguous route mutation. OneCode may change only routes it can prove it owns through its custody records and exact native state.

### User data

Do not delete or replace the user's existing OneCode profile just to make a clean-install test pass. Migration behavior must work with existing configuration, including an older Linux config whose `connectorSuffix` is blank.

## 2. Real Linux acceptance host

Host alias: `ubuntu-legion`

Verified environment:

- Ubuntu 22.04.5 LTS;
- kernel 6.8;
- x86_64 / amd64;
- GNOME Shell on X11;
- desktop user `hassan`;
- Tailscale 1.104.1, signed in and daemon active;
- `/usr/bin/pkexec` present;
- packaged/private Node 24.22.0 and npm 11.19.1 available;
- distro Node 12.22.9 also exists and is too old for this source tree;
- OneCode checkout: `/home/hassan/OneCode-linux`;
- user data: `/home/hassan/.config/OneCode`;
- source branch: `linux`.

The Linux checkout has had a pre-existing tracked modification to `THIRD-PARTY-NOTICES.txt` caused by target-specific notice generation. Preserve it across builds; do not reset or accidentally commit it.

## 3. Issue ledger: failures actually encountered

### 3.1 Tailscale looked signed in but Funnel mutation was denied

**Observed:** CLI/version checks and account status passed, but Connect failed on the first Serve/Funnel mutation.

**Root cause:** Linux Tailscale had no daemon operator configured. Read-only CLI commands were allowed for the desktop user, while route mutation was not.

**Fix:** before custody persistence or route mutation, Linux now checks `tailscale get operator`. If the current desktop user is not authorized, OneCode invokes a visible polkit action equivalent to:

```bash
tailscale set --operator=<current-user>
```

through `/usr/bin/pkexec`, with no shell, auth key, `tailscale up` or route mutation in that authorization step.

**Live result:** the operator became the desktop user and OneCode continued into route publication without a global Tailscale reset.

### 3.2 “Allow OneCode to use Tailscale” opened documentation instead of authorizing

**Observed:** the button opened a web page and changed nothing.

**Root cause:** renderer setup buttons were wired to `action.url` instead of the trusted main-process setup owner.

**Fix:** the operator action now uses dedicated IPC/main-process setup. A cancelled prompt can be retried explicitly by the user, while background prerequisite polling cannot repeatedly spawn authorization prompts.

### 3.3 OneCode opened Firefox even though Brave was selected

**Observed:** setup/provider/help links opened Ubuntu's OS-default Firefox despite OneCode being configured for Brave.

**Root cause:** generic `link:open` used Electron `shell.openExternal` for ordinary HTTPS links unless COS was selected.

**Fix:** ordinary HTTP/HTTPS links use OneCode's selected native browser family. `external: true` still means “escape the embedded COS browser” only when COS is the selected browser. Non-web schemes remain OS-owned.

**Windows audit:** verify the same behavior for Chrome/Edge/Brave and portable/custom browser executables. The selected browser must be the actual link owner, not merely the chat-launch owner.

### 3.4 Existing Linux config collided with Windows connector identity

**Observed:** an existing Linux config had `connectorSuffix: ""`, producing `OneCode Core`, the same historical name as an unsuffixed Windows installation.

**Fix:** Linux treats a blank/invalid stored suffix as `Linux` at runtime; fresh Linux defaults also store `connectorSuffix: "Linux"`. A valid explicit user suffix always wins. Windows historical blank naming remains unchanged.

Expected Linux defaults:

- `OneCode Core Linux`
- `OneCode Desktop Linux`
- `OneCode Plugins Linux`

### 3.5 Browser bridge looked for the wrong Core name

**Observed:** ChatGPT visibly showed `OneCode Core Linux`, but an app-authored message refused to send and said the current Core was unavailable.

**Root cause:** two bridge status paths built connector names directly from the stored suffix and skipped the Linux platform fallback. MCP advertised `OneCode Core Linux`; the Companion looked for `OneCode Core`.

**Fix:** all browser bridge identity now comes from the same platform-aware/configured connector-name owner used by MCP.

### 3.6 Identity fallbacks could still select another connector

After fixing the Linux suffix, the audit found additional permissive paths: remembered Core IDs, provider renames, plain-name defaults, legacy aliases and Gemini provider-name normalization.

**User correction:** there can be no fallback. Everything must use the name in OneCode.

**Fix (`ca7dbab`):** configured OneCode names are now the sole connector naming authority in MCP presentation, ChatGPT/Gemini adapters and Companion ownership tests. Provider renames are no longer adopted as model-facing identity.

### 3.7 Public probe crashed Electron on IPv6-unreachable Linux

**Observed:** after route publication Electron showed an uncaught main-process exception such as `connect ENETUNREACH <IPv6>:443`.

**Root cause:** the forced-address DNS `lookup` callback returned synchronously. Node could begin `connect()` before the request error listener was attached.

**Fix:** forced-address lookup now completes in a microtask. A dead IPv6 route becomes an ordinary transport failure while IPv4 keeps racing.

**Live result:** on the Legion all public IPv4 ingress addresses completed TLS while IPv6 was unreachable; OneCode stopped crashing and reached metadata/MCP HTTP 200.

### 3.8 Connected repeatedly fell back to “Connecting…” while the connector still worked

**Observed:** after a successful connection, OneCode repeatedly changed to `Connecting…`, sometimes around every message. Public MCP calls continued to return HTTP 200. Browser delivery could be delayed tens of seconds.

**Root cause:** the continuous Tailscale public-health check occasionally returned transient `dns-error`/TLS failures. Every single miss was reported as global `connecting-tunnel`. `connection.ts` then cleared the provider public route, marked Core `starting` and unpublished the connector even though the established route was still serving traffic.

**Source fix (`67b4ba0`):** once the connector has reached public `ready` at least once, transient public probe misses keep the global state `connected` and preserve the public URL/publication during the bounded retry window. The detailed `publicIngress` state still reports the degraded probe. Only a sustained failure past `retryWindowMs`, or loss of native custody, withdraws the connector.

**Tests:** Tailscale focused suite 49/49 passed after updating the old “withdraw on first miss” expectation.

**Final live result on `fcf5d3e`:** passed. Three sequential OneCode-authored sends were sampled every 250 ms while replies were produced. The capsule remained a 36 px `is-connected` dot with `aria-label=Connected`; its label track stayed zero-width/opacity-zero and no sample returned to `Connecting…`. Public metadata/MCP probes continued to return HTTP 200 throughout. The earlier screenshot showing a visibly open `Connecting…` capsule predates this final build and remains evidence of the pre-fix behavior, not of the accepted runtime.

### 3.9 Initial public connection could take ~40 seconds

**Observed:** after restart the connector sometimes needed ~44 seconds before the first public-ready state, even though later public HTTPS/MCP requests succeeded.

**Root cause:** OneCode intentionally resolves the Funnel hostname through public DoH rather than split/MagicDNS. The DoH HTTPS connections themselves were left to platform family selection. On a host with an AAAA-capable resolver but no usable IPv6 route, that could spend much of the 4-second DNS budget before trying IPv4.

**Source fix (`67b4ba0`):** non-forced DoH HTTPS connections use Node's Happy-Eyeballs family selection with a short 250 ms attempt delay. This does **not** trust local DNS or bypass DoH; it only improves how OneCode reaches Cloudflare/Google's trusted resolvers. Explicit Funnel ingress addresses remain individually verified.

**Tests:** `tailscale-public.test.ts` 70/70 passed; TypeScript passed.

**Final live result on `fcf5d3e`:** from the actual Connect/tunnel start, native Tailscale readiness was reached in 113 ms, routes were configured in 1.487 s, and first public-ready was reached in 10.828 s. The apparent ~21 s gap between application start and local MCP-server start was not a connection stall: this profile has `ui.autoConnect=false`, so Connect had not yet been initiated. Do not measure manual initiation time as tunnel latency.

### 3.10 ChatGPT visibly answered but OneCode showed no response

**Observed:** the browser accepted the app-authored message, invoked OneCode tools and visibly produced a final response. OneCode's transcript still showed only the user's message.

**Durable evidence:** the affected OneCode session recorded `turn_start`, local tool calls, `turn_end` and a page-tool recap, but its canonical message store was empty: no `user_message` and no `assistant_message` observations.

**Root cause:** current ChatGPT/GPT-6 shell rendering can keep the exact user ID and turn message IDs while omitting public user/final payloads from the typed `entry.turn.items` projection. The mounted live conversation mapping still contains the exact current branch. Fiber used that mapping only for request metadata, so lifecycle/tool evidence survived while transcript rows disappeared.

**Source fix (`67b4ba0`, corrected by `fcf5d3e`):** Fiber may recover public transcript rows from the **mounted live current-branch mapping only** when it is fenced by:

- the exact mounted `entry.turn` object;
- the exact user message ID already owned by the typed turn;
- `current_node` parent traversal back to that user;
- every `entry.turn.messageIds` member appearing on that one branch.

The recovery path copies only the exact user row or public assistant text routed to `all`/no recipient. Tool requests/results, thoughts, hidden rows, analysis, another branch, cache order, timing and DOM text are excluded.

The first recovery version replaced a typed shell row wholesale with its live-mapping row. That lost typed lifecycle fields such as phase/completion and broke fresh background-worker ACK ownership. `fcf5d3e` preserves the typed envelope and only fills missing public content; a live row is appended only when the typed projection omitted that row entirely.

**Tests:** `shell-compat.test.ts` passed 156/156 after `fcf5d3e`, including the live-current-branch transcript recovery and immediate/hydrating/foreign/retired worker-binding cases.

**Final live result:** passed on the Legion. Three sequential acceptance prompts produced unique canonical user rows and unique final assistant rows `ACCEPT-3`, `ACCEPT-4`, and `ACCEPT-5`, with zero duplicate canonical identities, and all three final responses were visibly rendered in OneCode.

**Storage note for future acceptance:** new canonical messages are stored as atomically replaceable shards under `sessions/<id>/messages/*.json`. `messages.json` is now the legacy whole-map overlay retained for lazy migration and may legitimately remain `{}` in a new session. Do not diagnose “empty transcript” by reading only `messages.json`; use the store reader or inspect the shard directory as well.

### 3.11 Access warning was real configuration, not Linux incapability

One snapshot said the provider could not edit files/run commands. The saved configuration was `readOnly: false` but only the `read` capability was enabled. That warning was accurate. Later live renderer state showed **Full access** selected and the limited warning hidden.

Do not hide permission warnings to make acceptance look green. Verify actual capabilities separately from connector health.

### 3.12 Ubuntu system Node/npm were too old for builds

Ubuntu's distro Node was 12.22.9. Parent commands launched with Node 24 could still invoke the old distro `node`/`npm` in nested scripts and fail on modern syntax.

The Linux package stages Node 24.22.0 + npm 11.19.1. Native build/acceptance must put that private runtime first in `PATH`; do not replace the OS Node globally just to build OneCode.

### 3.13 Linux packaging regenerated target-specific notices

`THIRD-PARTY-NOTICES.txt` can change during native target preparation. The Legion checkout already carried a tracked local notice difference. Acceptance scripts backed it up and restored it after every build.

Do not use `git reset --hard`, `git clean` or broad staging to hide this.

### 3.14 Full AppImage/DEB rebuilds were wasteful for tiny acceptance fixes

Full Linux AppImage and DEB packaging succeeded, but repeatedly recompressing them for one renderer/main-process fix was unnecessary.

For **developer acceptance only**, use:

```bash
npm run dist:dir:linux:x64
node scripts/smoke-packaged-runtime.mjs --platform linux --arch x64
```

and launch `release/linux-unpacked/onecode` in the real user desktop session.

This is **not** a production Linux hotfix updater. The installed AppImage is immutable SquashFS, and the current Windows capsule helper is Windows-specific.

### 3.15 Companion build changed while the browser still ran the old scripts

After a directory hotfix the fresh app correctly detected that Brave still ran an older Companion build, updated the stable extension folder and requested an idle reload. Logs then showed the new build reconnecting.

Windows installer acceptance must verify this exact transition too. Matching app version text is not sufficient; compare the Companion build stamp/protocol actually connected to the bridge.

### 3.16 Stale Companion `version_name`

The source had `extension/manifest.json` `version: 0.4.8` but stale `version_name: 0.4.5`.

History showed `version_name` used to move with `version`; it had simply stopped being bumped after 0.4.5. `b62a633` aligns it to 0.4.8.

Release audits must check both fields so the browser does not display a misleading older Companion version.

### 3.17 Command/quoting mistakes that were not product defects

Several ad-hoc Windows→SSH commands failed because PowerShell expanded Linux `$()`/quotes before SSH, and one X11 screenshot path failed because of root colormap/PIL conversion. These were operator/tooling mistakes, not OneCode bugs. Prefer single-quoted remote programs or small temporary shell scripts for complex SSH commands.

## 4. Final live acceptance on the real Ubuntu host

The following are proven on the real Ubuntu desktop with the final `fcf5d3e` unpacked runtime and Companion build `f32c3abe0050`:

- native packaged Linux runtime smoke passed;
- AppImage and DEB were built successfully;
- OneCode launched in the real GNOME/X11 session;
- Connect triggered the intended polkit Tailscale operator flow;
- operator authorization succeeded;
- OneCode published only custody-owned Funnel paths;
- public metadata and MCP initialize returned HTTP 200;
- connection reached `ready`;
- Linux exact connector identity appeared in ChatGPT;
- Brave received OneCode setup/provider links instead of the OS-default Firefox after the browser-routing fix;
- the Companion automatically reloaded to the build shipped by the active hotfix runtime.

Additional final-build proof:

- fresh `linux-unpacked` packaged-runtime smoke passed for Electron 44.3.0, MCP, Sharp/libvips, PNG, node-pty and tree-sitter;
- the app reached `renderer state ready` at 20:56:30.065Z and the Companion connected at 20:56:30.441Z;
- after Connect was initiated, Tailscale reported CLI ready in 43 ms, native ready in 113 ms, routes configured in 1.487 s, and public-ready in 10.828 s;
- three sequential sends (#3/#4/#5) were browser-claimed, answered, rendered locally and recorded canonically while the connection capsule remained Connected;
- the three final assistant shards were distinct, stable provider identities and there were no duplicate canonical user/final rows;
- public Funnel metadata and MCP probes continued returning HTTP 200 throughout the send sequence.

## 5. Reusable live acceptance sequence for later Linux builds

For a later hotfix/release candidate:

1. Verify the checkout still has only the known/intentional local modifications.
2. Fast-forward `/home/hassan/OneCode-linux` to the exact candidate commit.
3. Preserve `THIRD-PARTY-NOTICES.txt` exactly.
4. Use the private Node 24/npm runtime; do not use system Node 12.
5. For a QA hotfix, run the directory build only:

   ```bash
   npm run dist:dir:linux:x64
   node scripts/smoke-packaged-runtime.mjs --platform linux --arch x64
   ```

6. Stop the previous OneCode process cleanly; do not kill Tailscale.
7. Relaunch `release/linux-unpacked/onecode` as the desktop user in the real X11 session.
8. Remove any temporary `--remote-debugging-port` acceptance flag on the normal final relaunch.
9. Verify the Companion updates/reloads to the fresh build stamp.
10. Measure Connect from the actual user/auto Connect initiation to first `public-ready`; do not include idle time before Connect when `ui.autoConnect=false`.
11. Leave it connected through at least one naturally occurring transient DNS/TLS health miss. The UI must remain **Connected**, Core must remain published and MCP requests must continue succeeding.
12. Send a harmless new ChatGPT message from OneCode.
13. Verify the browser claims it promptly rather than waiting ~30 seconds for a reconnect cycle.
14. Verify the user message and final assistant response both appear in OneCode.
15. Verify the durable session message store contains canonical user + assistant records, not only lifecycle/tool events. Current writes are in `messages/*.json`; the legacy `messages.json` may stay empty.
16. Confirm the exact current connector name remains the one attached by the Companion.

Only after steps 10–16 pass should reconnect/transcript bugs be marked live-fixed. They passed for `fcf5d3e` on the Legion.

## 6. Windows installer regression audit derived from Linux failures

The Windows installer/installed app must be checked against the same invariants instead of assuming a Linux-only root cause.

### Connection and Tailscale

- A successful live connector must not become `Connecting…` because one background public-health sample fails.
- Transient `dns-error`, `tls-error`, `timeout` or one dead address family must retain the established public URL and publication during the retry window.
- A sustained outage must eventually withdraw honestly.
- Route mutations must remain custody-scoped.
- Repair/service-restart actions must not replay uncertain mutations.
- Initial public verification should not wait on an unusable address family when another works.

### Connector identity

- Provider attachment must use only the exact connector name OneCode currently displays.
- No plain-name, legacy-name, provider-rename, remembered-ID or normalized-name fallback.
- One account with connectors from two physical computers must route each machine only to its own exact Core.
- `serverInfo.name`, `serverInfo.title`, protected-resource metadata, Setup card and browser Companion must agree.

### Browser ownership

- Selecting Brave/Chrome/Edge must make generic OneCode web actions use that browser, not the OS default.
- Portable/custom executable selection must remain honored.
- After app update, the installed Companion folder must update/reload to the new build stamp before managed sends continue.

### Chat recording

- A successful app-authored ChatGPT send must produce canonical local user and assistant messages, not only tool/lifecycle events.
- Verify GPT-6 shell/tool-heavy answers, including turns where typed shell items omit public payloads.
- Do not restore broad DOM-text guessing as a competing message source.
- Inspect the canonical shard store (`messages/*.json`) or the application store reader; an empty legacy `messages.json` alone is not evidence of missing transcript data.
- Verify transcript recovery does not replace typed lifecycle envelopes or break worker ACK ownership.

### Permissions

- A limited-access warning must reflect actual saved capabilities.
- Full access must expose create/edit/command where supported.
- A connection being healthy must not be confused with having write authority.

### Version/update consistency

- `package.json` version, `src/main/version.ts` `APP_VERSION`, `extension/manifest.json` `version` and `version_name` must agree.
- Companion bridge protocol/build stamp must match what the running browser loaded.
- A full installer must preserve the existing user profile and extension stable folder.

## 7. Common version-update checklist

For a real release/hotfix version bump, keep these synchronized:

1. `package.json` → `version`.
2. `package.json` → `shortVersionWindows` for a new full Windows executable, normally `<version>.0`.
3. package-lock root/package version if package.json changes it.
4. `src/main/version.ts` → `APP_VERSION`.
5. `extension/manifest.json` → both `version` and `version_name`.
6. `src/renderer/whats-new.ts` → release summary for the exact new application version when appropriate.
7. Keep `BRIDGE_PROTOCOL` unchanged unless the app↔Companion wire contract changed incompatibly. If it did, bump it deliberately and update both sides/tests.

`scripts/write-extension-stamp.mjs` runs during packaging and stamps the exact Companion bytes that ship.

## 8. Windows full release procedure

Use a native Windows checkout with the synchronized version above.

1. Run the source gate:

   ```powershell
   npm run verify:ci
   ```

2. Build Windows x64 installer + unpacked runtime:

   ```powershell
   npm run dist:x64
   ```

   `scripts/package.mjs` automatically performs packaged-runtime smoke and installer checks after assembly.

3. Prepare/verify public release assets:

   ```powershell
   node scripts/prepare-windows-release.mjs
   ```

   This verifies the packaged app/Companion versions, installer metadata, native runtime inventory and checksums; writes `OneCode-Base-x64.json`; packages the Companion/skills; and writes `SHA256SUMS.txt`.

4. For a transition that must deliberately exclude the application capsule, use the documented `--full-only` mode instead:

   ```powershell
   node scripts/prepare-windows-release.mjs --full-only
   ```

   Do this only when the release plan specifically calls for it.

5. Publish the verified assets from `release/` to the exact GitHub release tag. Do not publish stale files left from another version.
6. Install/update through the actual installer and perform the regression audit in section 6.

Important full-release properties:

- NSIS is per-user, `asInvoker`, no elevation helper, and preserves app data on uninstall.
- A full release contains the current application snapshot including all earlier hotfixes.
- It establishes the native runtime/base receipt that later Windows application capsules must match.

## 9. Windows application hotfix procedure

Windows has a real small application-hotfix mechanism. Follow `docs/HOTFIX-UPDATES.md` as the authoritative detailed contract.

Use it only when Electron/Node/native modules/tunnel/native packaged resources remain compatible with the latest complete base.

1. Bump the normal three-part app + Companion version and keep the version files in section 7 aligned.
2. Run relevant tests and `npm run verify:ci`.
3. Build only the Windows directory application layer:

   ```powershell
   npm run dist:dir:x64
   ```

4. Publish a hotfix capsule against the newest compatible full base:

   ```powershell
   npm run release:hotfix -- --base-version <X.Y.Z>
   ```

5. Publish exactly the hotfix release inputs produced for that version, notably:

   - `OneCode-Hotfix-x64.zip`
   - `OneCode-Hotfix-x64.json`
   - `SHA256SUMS.txt`

   Do **not** upload a leftover installer into a hotfix-only release.

6. If the runtime/native fingerprint differs from the declared base, stop and make a full release instead.

The Windows capsule is a complete snapshot of approved mutable application resources, not a binary delta. It cannot replace Electron, Node, native modules, tunnel binaries, private profiles or credentials. Activation is performed by the Windows-specific detached helper with checksum/inventory verification and rollback rules.

## 10. Linux full release procedure

Linux already has real AppImage and DEB packaging in `electron-builder.yml`.

1. Synchronize the version files in section 7.
2. Build/test from a native Linux environment with the verified private Node/npm runtime first in `PATH`.
3. Run:

   ```bash
   npm run verify:ci
   npm run dist:linux:x64
   ```

4. `scripts/package.mjs` stages target-specific tunnel/ripgrep/Node/native modules, builds the app, invokes electron-builder and runs packaged-runtime smoke.
5. Expected x64 artifacts include:

   - `release/OneCode-Linux-x64.AppImage`
   - `release/OneCode-Linux-x64.deb`
   - `release/linux-unpacked/`

6. Run the AppImage on a supported real desktop session, preserving the existing `~/.config/OneCode` profile, and execute the live acceptance sequence.
7. Test DEB installation separately as a package-manager-owned install; do not treat a DEB as an in-place self-replacing AppImage.
8. Publish only artifacts built from the exact release commit. Generate/publish release checksums according to the release process; there is currently no Linux equivalent of `prepare-windows-release.mjs` that establishes a Windows-style capsule base descriptor.

AppImage is the preferred current self-contained Linux distribution. OneCode's updater has AppImage replacement support; DEB remains owned by the system package manager/manual package path.

## 11. Linux hotfix procedure: current reality

### Production users

There is **no current production Linux application-capsule hotfix equivalent to Windows**.

An AppImage's SquashFS application payload is immutable. The current hotfix manifest, runtime fingerprint and detached activation helper are explicitly Windows-specific. Do not copy the Windows capsule into an AppImage or claim `release:hotfix` supports Linux.

For a production Linux fix today, publish a new versioned AppImage/DEB through the normal Linux release path. That may be a small code change semantically, but distribution is still a full Linux package replacement.

### Engineering/acceptance hotfix

For fast testing on the Legion without rebuilding/compressing full release artifacts:

```bash
npm run dist:dir:linux:x64
node scripts/smoke-packaged-runtime.mjs --platform linux --arch x64
```

Then relaunch `release/linux-unpacked/onecode` in the real desktop session. This is the path used during this port because it exercises the packaged application layer and Companion while avoiding repeated 200+ MB AppImage/DEB recompression.

Do not distribute `linux-unpacked` as though it were an updater.

### If a true small Linux hotfix mechanism is desired later

Design it explicitly rather than reusing Windows assumptions. At minimum it needs:

- a writable application activation target outside immutable AppImage SquashFS;
- exact allowed-file inventory and hashes;
- architecture/runtime compatibility identity;
- versioned staging;
- atomic activation;
- rollback/recovery semantics;
- protection against traversal, symlinks, case/path aliases and oversized payloads;
- a clear interaction with AppImage replacement and DEB ownership.

Until that exists, the release package is the Linux production update unit.

## 12. Linux directory-hotfix build recipe used during acceptance

Because Ubuntu's system Node/npm are too old, acceptance copied the already verified packaged runtime to `/tmp` before rebuilding the directory that originally contained it. The important sequence is:

```bash
cd /home/hassan/OneCode-linux

# Preserve the checkout's existing target-specific notices modification.
backup=$(mktemp)
cp THIRD-PARTY-NOTICES.txt "$backup"
trap 'cp "$backup" THIRD-PARTY-NOTICES.txt; rm -f "$backup"' EXIT

# Copy the verified private runtime out of linux-unpacked before replacing that directory.
NODE_ROOT=/tmp/onecode-node24-runtime
rm -rf "$NODE_ROOT"
cp -a release/linux-unpacked/resources/node "$NODE_ROOT"
ln -sf "$NODE_ROOT/lib/node_modules/npm/bin/npm-cli.js" "$NODE_ROOT/bin/npm"
ln -sf "$NODE_ROOT/lib/node_modules/npm/bin/npx-cli.js" "$NODE_ROOT/bin/npx"
export PATH="$NODE_ROOT/bin:$PATH"

node -v
npm -v
npm run dist:dir:linux:x64
node scripts/smoke-packaged-runtime.mjs --platform linux --arch x64
```

Do not replace Ubuntu's system Node globally.

## 13. Remaining Linux parity work after tunnel/transcript stabilization

Once the current live acceptance passes, continue the broader parity audit rather than declaring Linux complete:

- start-at-login behavior on Linux;
- manual browser executable chooser if any Windows-only path remains;
- current PocketSphinx Linux dictation implementation and microphone acceptance;
- CUA Driver install/use and Core plugin discovery;
- external plugin installer proving it uses the packaged Node/npm runtime;
- clean AppImage install/update acceptance;
- clean DEB install/uninstall/update acceptance;
- AppImage self-update acceptance;
- browser/provider acceptance across supported browsers;
- any Linux-specific secure-storage edge cases.

## 14. Repository hygiene

The canonical Windows workspace contains many untracked local acceptance/release helper files and `tmp/`. They are not permission to clean the tree.

Never use broad destructive cleanup such as:

```text
git clean
git reset --hard
```

Stage only the intended tracked source/docs files for each commit.

The local `/test/` tree is ignored in this workspace. Focused test edits can still be used for validation, but do not force-add the whole ignored test tree merely to make a patch include tests unless repository policy is deliberately changed.

## 15. Definition of done for the current blocker

The immediate Linux/Windows shared blocker is not done until all of these are true on a live installed/packaged path:

- first Connect reaches public-ready without unnecessary address-family delay;
- a transient public probe miss does not change a previously live connector to `Connecting…`;
- public Core remains attached/published while the transient health check retries;
- a OneCode-authored ChatGPT message is claimed promptly and submitted once;
- ChatGPT can call the exact current Core;
- the final browser response appears in OneCode;
- the durable session contains canonical user and assistant messages;
- the Companion/app displayed versions and build stamp agree;
- the exact-name-only connector rule remains intact.

Then run the same regression checklist against the Windows installed build before promoting the Linux-port work into the next release.

### Current Linux result

All bullets above passed on the final `fcf5d3e` Legion acceptance run. No additional connection-capsule patch was required in this continuation: the current runtime stayed Connected through three sequential sends, and the earlier visible `Connecting…` screenshot was from an older build. The remaining work is the broader Linux parity list in section 13 plus the Windows installed-build audit in section 6.
