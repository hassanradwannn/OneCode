# Application hotfix updates

Windows has supported verified application capsules since the 0.4.x line. OneCode 0.5.0 adds the corresponding application-layer foundation for Linux AppImage installations. A hotfix is never a shortcut around an incompatible native runtime: every capsule is bound to an exact complete base/runtime fingerprint, and native/runtime changes require a full platform artifact.

DEB installations remain package-manager-owned. OneCode may discover and offer the exact DEB for a newer release, but it does not rewrite root-owned package state during ordinary shutdown and does not activate a user-space capsule behind the package manager's back.

## Publish a compatible Windows hotfix

From the canonical checkout, increment the normal three-part application version and matching Companion version. Run the relevant tests and public verification, then:

```powershell
npm run dist:dir:x64
npm run release:hotfix -- --base-version 0.4.5
```

Use the latest complete release compatible with this runtime as --base-version. The publisher verifies that release's checksum list and OneCode-Base-x64.json, including the installer digest, size, architecture and native fingerprint. Missing or changed native resources require a new full release rather than an application hotfix.

The directory build runs packaged runtime smoke without assembling NSIS. The publishing command creates OneCode-Hotfix-x64.zip, OneCode-Hotfix-x64.json and SHA256SUMS.txt; publish these three files to the exact version's release. The manifest embeds the verified full-base descriptor. Do not upload a leftover installer. The standalone command replaces the checksum list so stale installers cannot be advertised.

Build complete releases from the `release` branch after all earlier hotfix commits, using `npm run dist:x64` and `node scripts/prepare-windows-release.mjs`. Preparation writes `OneCode-Base-x64.json` and includes it in release checksums. The normal mode can also emit a matching application capsule. A full release contains the current application snapshot, including prior hotfixes; it does not revert to an earlier application snapshot.

The capsule is a complete snapshot of allowed application resources, not a binary delta. It contains app.asar, Companion, bundled skills, updater helpers, setup text and third-party notices. It cannot replace Electron, Node, native modules, tunnel binaries, private profiles or credentials. Every manifest entry has an exact path, byte count and SHA-256; the archive and manifest also match the release checksum list. The trust source is the configured OneCode GitHub publisher over HTTPS, as with the existing installer updater; an independent code-signing signature is not claimed.

## Runtime compatibility and activation

A hotfix-only latest release has no installer asset or latest-x64.yml. Keep the README's fresh-install link pinned to the latest complete release. The 0.4.5 updater discovers the normal three-part hotfix tag and verifies SHA256SUMS.txt plus the manifest. A compatible installation downloads only the capsule. Otherwise it independently verifies the required base descriptor and installer against the base release's checksums, downloads both artifacts into versioned stages, and offers one install action. Legacy hotfix manifests without a base remain usable on compatible installations; they cannot authorize a guessed installer.

Downloads report actual received bytes, weighted across the base and hotfix when both are required; 100% means the whole plan has verified and staged. Full Windows feeds are pinned to the selected tag, never reselected from a moving latest release during download.

## Maintain the What's new pane

Use the existing `src/renderer/whats-new.ts` RELEASES table. Add an entry keyed by the exact normal three-part APP_VERSION, with a short lead and concise highlights using the existing icon vocabulary and literal `t()` calls. Keep package.json, src/main/version.ts and extension/manifest.json versions aligned, then regenerate the Companion stamp. A release without an entry records the version quietly; it cannot show highlights that were never bundled.

The pane compares the installed version with the existing config.ui.lastSeenVersion. A real update shows it once after startup settles; another modal defers it until closing. The existing main-process ui:whatsNewSeen owner records only APP_VERSION after the pane actually opens. Fresh installs and same-version restarts stay quiet. Users can reopen the same installed-version summary from **Settings → General → What's new → View changes**. Full release notes opens that exact version's GitHub release. Keep these highlights, release notes, README and handoff consistent; the pane is a release summary, not proof that a particular installation method ran.

## Runtime verification

An application hotfix retains the base executable and Windows installation registration, so their file/display version may remain at the base release. OneCode's own installed version and What's new pane report the activated application version. This is expected when the native runtime is retained.

The Windows after-pack hook records the immutable resource inventory and exact Electron version in resources/updater/runtime.json. Direct capsules must match that baseline. A composite plan uses bootstrap schema3: verify both payloads before mutation, wait for the old process tree, execute the exact base installer with --onecode-bootstrap, verify its product version and registration, verify its new native inventory against the hotfix, then apply the patch and launch the final application once. The installer never owns an intermediate app launch. An unexpected running successor stops replacement; it is not killed.

The main update owner verifies and expands the archive into its versioned cache, refusing traversal, links, case aliases, unexpected entries and oversized data. Explicit Install when done retains the current version/work fences and durable shutdown. The helper runs from a copied Node runtime outside the install, checks the registered target, saves rollback copies and replaces only allowed files. Removed application files are retired as part of the snapshot. Success requires the new application to log its expected version and keep a loaded visible window alive.

Failures before a successor runs restore the verified previous application snapshot. In a composite update that snapshot is the newly installed base; rollback does not reverse the native installer. An uncertain base installer is not replayed. A running unconfirmed successor is left alone with its rollback copy retained. A forced shutdown or power loss during replacement requires the retained backup or a full installer; automatic recovery is not claimed.

The installed full-base version is recorded by the after-pack hook in resources/updater/runtime.json. It is independent of the application version: applying an app capsule cannot advance this base receipt. A matching native hash alone does not satisfy a newer required base; a missing legacy base receipt also requires the verified full base. The detached helper checks the same receipt after installation.

## Linux AppImage hotfixes

0.5.0 is the first Linux complete base that contains the immutable hotfix bootstrap. An older Linux AppImage cannot bootstrap the feature through a capsule; install the full 0.5.0 AppImage first.

The complete Linux package writes `resources/updater/runtime.json` with schema 2. Its fingerprint includes the platform/architecture, Electron version, immutable resource inventory, complete-base version, and the hash of the packaged bootstrap itself. Mutable application resources are deliberately excluded from that native fingerprint and are instead listed in the capsule manifest.

The AppImage's mounted SquashFS is never patched in place. A verified capsule is expanded into a versioned directory under OneCode's user-data-owned `application-layers` directory. Activation writes a bounded receipt naming the exact runtime/base and the full application-file inventory. On every launch the immutable bootstrap revalidates that receipt and every file before executing the sidecar `app.asar`. Mutable packaged resources such as the Companion, bundled skills and updater helpers resolve from that same selected layer so a hotfix cannot run new application code against stale mutable resources.

Startup is fail-safe. Before executing an activated layer the bootstrap writes a launch marker. The normal main window clears the marker only after reaching `ready-to-show`. If the process dies first, the next immutable bootstrap restores the previous activation receipt (or the bundled application) rather than boot-looping the failed layer. The native AppImage remains unchanged throughout.

### Build a complete Linux base

Use a verified modern Linux Node runtime (the release pipeline currently pins Node 24.22.0/npm 11.19.1), then:

```bash
npm run verify:ci
npm run dist:linux:x64
npm run release:prepare:linux
```

The final preparation step verifies the AppImage, DEB and packaged runtime, writes `OneCode-Linux-Base-x64.json`, creates a matching `OneCode-Linux-Hotfix-x64.zip` + `.json`, and updates `SHA256SUMS.txt`. The matching capsule establishes/proves the base contract; users installing that same full release do not need to apply the redundant capsule afterward.

### Publish a later compatible Linux application hotfix

Build the updated application against the same immutable runtime, then name the newest compatible complete Linux base explicitly:

```bash
npm run dist:dir:linux:x64
npm run release:hotfix:linux -- --base-version 0.5.0
```

Replace `0.5.0` with the latest compatible complete Linux base. The publisher downloads that base descriptor and checksum list from its exact GitHub tag, verifies the AppImage digest and runtime fingerprint, and refuses the hotfix if any immutable resource changed. A standalone hotfix checksum list does not advertise stale AppImage/DEB/base files from the local release directory.

Linux capsule assets are platform-qualified:

- `OneCode-Linux-Hotfix-x64.zip`
- `OneCode-Linux-Hotfix-x64.json`
- `SHA256SUMS.txt`

Native runtime changes, a different bootstrap, a different packaged Node/native module/tunnel/rg payload, or another incompatible immutable resource require a new full AppImage/DEB release.

## Platform-aware release selection

GitHub's moving `/releases/latest` is a repository-wide concept, but OneCode update applicability is platform/install-type specific. The updater therefore treats a release with no applicable delivery artifact as not applicable to that installation instead of surfacing a broken update. Publication policy should still prefer synchronized versions that provide a valid delivery path for every supported platform.

For 0.5.0 and later, a synchronized full release should publish at least the Windows installer/base metadata and the Linux AppImage/DEB/base metadata together. A future hotfix-only release should publish the applicable Windows and Linux capsules together when both bases are compatible; when a platform requires a new native base, publish that platform's full artifact in the same version rather than making the other platform's updater chase a nonexistent file.

Fresh-install links must always target a complete base artifact, never a capsule. “Latest application version” and “latest complete installable base” are distinct concepts.
