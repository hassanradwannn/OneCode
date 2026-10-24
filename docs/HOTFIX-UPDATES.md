# Application hotfix updates

Windows has supported verified application capsules since the 0.4.x line. OneCode 0.5.0 added the corresponding application-layer foundation for Linux. A hotfix is never a shortcut around an incompatible native runtime: every capsule is bound to a verified complete-base/runtime fingerprint, and native/runtime changes require a full platform artifact. Current stable hotfixes are built on GitHub from one frozen source commit for Windows x64 and Linux x64.

Current stable source allows a positively identified DEB installation to activate a compatible application capsule in the same user-space layer used by AppImage. The full DEB and native runtime remain package-manager-owned: incompatible updates offer the exact DEB and require normal package installation. OneCode never rewrites root-owned package files during shutdown.

Packaged Linux directory builds have an explicit QA installation kind, an isolated default profile and no production updater. A missing `APPIMAGE` environment variable alone does not prove DEB ownership. Changes to immutable bootstrap classification/profile rules require a new complete Linux base; they cannot be delivered to an older base as an application capsule.

## Stable release policy

Every new stable OneCode version publishes both delivery forms from the same frozen source commit:

- a complete Windows installer plus Linux AppImage/DEB and their base descriptors for new users and clean installs;
- cumulative Windows/Linux application capsules bound to the oldest intentionally supported published stable base whose immutable runtime still matches, so existing compatible users get the smaller internal update.

Use the `stable-release` GitHub operation for ordinary future stable releases. It builds the full artifacts and the backward-compatible capsules on GitHub, verifies both platform runtimes, and uploads the curated set to the same draft. A runtime mismatch fails the release; never weaken the compatibility contract just to keep the capsule small.

```sh
gh workflow run draft-app-build.yml --repo hassanradwannn/OneCode --ref release \
  -f source_ref=EXACT_40_CHARACTER_COMMIT_SHA -f release_tag=vX.Y.Z \
  -f operation=stable-release -f base_version=VERIFIED_MINIMUM_BASE -f platform=all
```

`stable-capsule` remains available for exceptional hotfix-only releases, but it is no longer the normal stable publication shape. `stable-full-backfill` is a guarded repair operation for adding missing full artifacts to an already-published stable tag without replacing existing assets; do not use it as the normal release workflow.

Beta follows the same delivery policy on its isolated prerelease channel. Normal Beta publication uses `beta-release`: GitHub builds a complete Beta Windows installer and Linux AppImage/DEB plus Beta capsules bound to the oldest intentionally supported published Beta base whose runtime matches. `beta-full-backfill` is the guarded equivalent for adding missing full artifacts to an already-published Beta prerelease without moving the tag or replacing its existing capsule assets. Stable and Beta package identities, updater feeds, profiles, bridge ports and base descriptors remain channel-separated.

```sh
gh workflow run draft-app-build.yml --repo hassanradwannn/OneCode --ref release \
  -f source_ref=EXACT_40_CHARACTER_COMMIT_SHA -f release_tag=beta-vX.Y.Z \
  -f operation=beta-release -f base_version=VERIFIED_MINIMUM_BETA_BASE -f platform=all
```

## Publish a compatible Windows hotfix

From the canonical checkout, increment the normal three-part application version and matching Companion version, run the relevant focused tests and public verification, commit only the intended paths, push `release`, and freeze the exact 40-character source SHA. Create the exact version tag and an unpublished draft release before dispatching the cloud build.

```sh
gh workflow run draft-app-build.yml --repo hassanradwannn/OneCode --ref release \
  -f source_ref=EXACT_40_CHARACTER_COMMIT_SHA -f release_tag=vX.Y.Z \
  -f operation=stable-capsule -f base_version=VERIFIED_MINIMUM_BASE -f platform=all
```

Use the **minimum published complete base you intentionally support**, not simply the newest application version. The workflow verifies that base release's checksum list and platform base descriptor, including artifact digest, size, architecture and immutable runtime fingerprint. A newer application version does not imply a newer required base. Missing or changed immutable resources require a new full release rather than an application hotfix.

The `stable-capsule` workflow uses a directory package, runs the public verification and packaged-runtime smoke on the matching platform runner, then uploads only the curated capsule assets to the exact draft. For Windows these are `OneCode-Hotfix-x64.zip`, `OneCode-Hotfix-x64.json` and `SHA256SUMS-win32-x64.txt`. Linux has its own qualified capsule and sidecar. Do not upload a leftover installer, AppImage, DEB, blockmap or full feed to a hotfix-only release.

Build complete releases from the `release` branch after all earlier hotfix commits, using `npm run dist:x64` and `node scripts/prepare-windows-release.mjs`. Preparation writes `OneCode-Base-x64.json` and includes it in release checksums. The normal mode can also emit a matching application capsule. A full release contains the current application snapshot, including prior hotfixes; it does not revert to an earlier application snapshot.

The capsule is a complete snapshot of allowed application resources, not a binary delta. It contains app.asar, Companion, bundled skills, updater helpers, setup text and third-party notices. It cannot replace Electron, Node, native modules, tunnel binaries, private profiles or credentials. Every manifest entry has an exact path, byte count and SHA-256; the archive and manifest also match the release checksum list. The trust source is the configured OneCode GitHub publisher over HTTPS, as with the existing installer updater; an independent code-signing signature is not claimed.

## Runtime compatibility and activation

A hotfix-only latest release has no installer/AppImage/DEB asset or full feed. Keep README fresh-install links pinned to the latest complete release. The updater discovers the normal three-part hotfix tag and verifies the release `SHA256SUMS.txt` plus the platform manifest. A compatible installation downloads only the capsule. Otherwise it independently verifies the required base descriptor and complete artifact against that base release's checksums, downloads both artifacts into versioned stages where supported, and offers one install action. Legacy hotfix manifests without a base remain usable only on compatible installations; they cannot authorize a guessed complete artifact.

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

## Linux application hotfixes

0.5.0 is the first Linux complete base that contains the immutable hotfix bootstrap. An older Linux AppImage cannot bootstrap the feature through a capsule; install the full 0.5.0 AppImage first.

The complete Linux package writes `resources/updater/runtime.json` with schema 2. Its fingerprint includes the platform/architecture, Electron version, immutable resource inventory, complete-base version, and the hash of the packaged bootstrap itself. Mutable application resources are deliberately excluded from that native fingerprint and are instead listed in the capsule manifest.

The AppImage's mounted SquashFS is never patched in place. A verified capsule is expanded into a versioned directory under OneCode's user-data-owned `application-layers` directory. Activation writes a bounded receipt naming the exact runtime/base and the full application-file inventory. On every launch the immutable bootstrap revalidates that receipt and every file before executing the sidecar `app.asar`. Mutable packaged resources such as the Companion, bundled skills and updater helpers resolve from that same selected layer so a hotfix cannot run new application code against stale mutable resources.

Startup is fail-safe. Before executing an activated layer the bootstrap writes a launch marker. The normal main window clears the marker only after reaching `ready-to-show`. If the process dies first, the next immutable bootstrap restores the previous activation receipt (or the bundled application) rather than boot-looping the failed layer. The native AppImage remains unchanged throughout.

The reliability release also supports a combined AppImage update when a later hotfix requires a missing complete base. The updater verifies the hotfix's embedded base descriptor against that base release's own checksums, then downloads and verifies both the exact AppImage and cumulative application capsule before offering installation. Shutdown prepares the selected layer for that successor, atomically replaces the AppImage, and relaunches once into the final application version. It never launches the intermediate base. A failed AppImage replacement restores the prior layer receipt; the immutable successor bootstrap still verifies the actual base/runtime and every selected application file before execution. A crash between the receipt and AppImage swap may fall back to the old bundled application on the next manual launch; it cannot execute a mismatched layer or authorize an automatic retry.

### Build a complete Linux base

Use a verified modern Linux Node runtime (the release pipeline currently pins Node 24.22.0/npm 11.19.1), then:

```bash
npm run verify:ci
npm run dist:linux:x64
npm run release:prepare:linux
```

The final preparation step verifies the AppImage, DEB and packaged runtime, writes `OneCode-Linux-Base-x64.json`, creates a matching `OneCode-Linux-Hotfix-x64.zip` + `.json`, and updates `SHA256SUMS.txt`. The matching capsule establishes/proves the base contract; users installing that same full release do not need to apply the redundant capsule afterward.

### Publish a later compatible Linux application hotfix

The stable GitHub workflow builds Linux from the same frozen source used for Windows. Name the verified minimum compatible complete Linux base explicitly; the Linux job fails closed if its immutable runtime or channel differs:

```bash
gh workflow run draft-app-build.yml --repo hassanradwannn/OneCode --ref release \
  -f source_ref=EXACT_40_CHARACTER_COMMIT_SHA -f release_tag=vX.Y.Z \
  -f operation=stable-capsule -f base_version=VERIFIED_MINIMUM_BASE -f platform=linux
```

The publisher reads that base descriptor and checksum list from its exact GitHub tag, verifies the AppImage digest and runtime fingerprint, and refuses the hotfix if any immutable resource changed. A capsule sidecar never advertises stale AppImage/DEB/base files from a local release directory.

Linux capsule assets are platform-qualified:

- `OneCode-Linux-Hotfix-x64.zip`
- `OneCode-Linux-Hotfix-x64.json`
- `SHA256SUMS-linux-x64.txt`

Native runtime changes, a different bootstrap, a different packaged Node/native module/tunnel/rg payload, or another incompatible immutable resource require a new full AppImage/DEB release.

## Isolated Beta builds

Build a Beta from the same canonical `release` checkout with `node scripts/package.mjs --channel beta --platform win32 --arch x64` (or `--platform linux`). The numeric package version stays three-part; the product displays that version followed by **Beta**. Windows uses its own NSIS identity and executable, Linux its own package name, and the default profile and Companion bridge ranges are separate from stable.

Beta publication uses the exact prerelease tag `beta-v<version>` and `OneCode-Beta-` artifact names. Its updater selects only Beta prereleases and verifies channel-bound base/runtime/capsule metadata. Stable updates never select Beta artifacts. The same verified full, compatible-hotfix and combined-base-plus-hotfix paths serve each channel. A development checkout's optional Git updater is a separate workflow and does not establish installed updater acceptance.

Explicit acceptance profiles and browser-profile overrides survive the Windows updater handoff. A Beta launch refuses the normal or legacy production application profile. Preserve an existing Beta profile when replacing an earlier development launcher; do not migrate production credentials or history into it.

## Platform-aware release selection

GitHub's moving `/releases/latest` is a repository-wide concept, but OneCode update applicability is platform/install-type specific. The updater therefore treats a release with no applicable delivery artifact as not applicable to that installation instead of surfacing a broken update. Publication policy should still prefer synchronized versions that provide a valid delivery path for every supported platform.

For 0.5.0 and later, a synchronized full release should publish at least the Windows installer/base metadata and the Linux AppImage/DEB/base metadata together. A synchronized hotfix-only release publishes both platform capsules and sidecars, then combines the four manifest/archive rows into the release-level `SHA256SUMS.txt` that update discovery trusts. The combined register must not advertise absent full artifacts. When a platform requires a new native base, publish that platform's full artifact in the same version rather than making another platform's updater chase a nonexistent file.

Fresh-install links must always target the complete artifacts from the latest stable release. Existing compatible installations should prefer that same release's smaller capsule through the internal updater. “Latest application version” and “latest complete installable base” should therefore normally be the same version, while the capsule may still target an older compatible immutable base.
