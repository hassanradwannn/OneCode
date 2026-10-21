# Windows application hotfix updates

OneCode 0.4.5 includes the complete cumulative application and repaired updater. Existing users take this full release through Settings. Later compatible hotfixes use smaller downloads; if a hotfix requires a missing native base, the updater stages the declared full release and the hotfix together, then installs both before one final relaunch.

## Publish a compatible hotfix

From the canonical checkout, increment the normal three-part application version and matching Companion version. Run the relevant tests and public verification, then:

```powershell
npm run dist:dir:x64
npm run release:hotfix -- --base-version 0.4.5
```

Use the latest complete release compatible with this runtime as --base-version. The publisher verifies that release's checksum list and OneCode-Base-x64.json, including the installer digest, size, architecture and native fingerprint. Missing or changed native resources require a new full release rather than an application hotfix.

The directory build runs packaged runtime smoke without assembling NSIS. The publishing command creates OneCode-Hotfix-x64.zip, OneCode-Hotfix-x64.json and SHA256SUMS.txt; publish these three files to the exact version's release. The manifest embeds the verified full-base descriptor. Do not upload a leftover installer. The standalone command replaces the checksum list so stale installers cannot be advertised.

Build complete releases from main after all earlier hotfix commits, using npm run dist:x64 and node scripts/prepare-windows-release.mjs. Preparation writes OneCode-Base-x64.json and includes it in release checksums. The normal mode can also emit a matching application capsule. For the 0.4.5 updater transition, --full-only excludes the capsule so older clients download the complete release through their existing installer path. A full release contains the current application snapshot, including prior hotfixes; it does not revert to an earlier application snapshot.

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
