# OneCode next-update handoff — 2026-10-30

## Current state

Stable `release` contains the unpublished launcher repair in commit `6af893e173355da539a63401128c741d1bfe263b`. Published Stable **0.8.2** remains pinned to `e52fb29f7344d77ccfaa619c32a4b0619656b243`: do not move that tag or replace its assets. Source version fields still say 0.8.2 because no subsequent release has been prepared or published in this follow-up.

The maintainer manually updated Ubuntu and reported working update progress. They then requested a dock-pinning repair and this handoff. Only that launcher repair was performed on the installed host: no update, application restart, setup change, credential change or service mutation. Further production updates and setup verification remain manual unless the maintainer explicitly changes that instruction.

## Dock defect and repair

GNOME Shell 42.9 saw both `io.onecode.desktop` and `io.onecode.desktop.desktop` with `StartupWMClass=io.onecode`. The 0.8.2 repair set `NoDisplay=true` on the legacy entry, but GNOME 42 still indexes it and can associate the running window with that hidden application. Its tie-break checks the complete desktop ID rather than the suffix-stripped ID and does not prefer a visible entry. This explains why a pin disappears despite a valid visible launcher. [Upstream matching implementation](https://github.com/GNOME/gnome-shell/blob/42.9/src/shell-app-system.c#L87-L114).

`src/main/linux/shortcuts.ts` now:

- Proves that the executable of each existing user launcher belongs to the verified current installation, retaining the existing ownership and symlink guards.
- Migrates an existing legacy favourite before retiring its launcher. A failed settings read/write leaves the alias usable; unrelated favourites and arguments remain intact.
- Removes the alias's window-class claim and marks it `Hidden=true` as well as `NoDisplay=true`. This excludes it from desktop-app discovery; hiding only its menu row is insufficient.
- Creates a visible canonical entry if only a retired owned alias remains, handles GNOME's `@as []` empty list, preserves desktop action groups, and remains idempotent.
- Preserves original files under `.before-launcher-identity` without replacing prior backups.

On the maintainer's current Ubuntu host, only the equivalent desktop-entry correction and requested pin were applied. Gio then exposed one visible OneCode desktop application. Native CUA inspection showed one OneCode dock entry with **Remove from Favorites** in its context menu. The original process remained alive and configuration, connector-proof and active-layer file hashes were unchanged. The old launcher's bytes and the original favourites list were backed up locally before mutation.

## Verification and local evidence

The initial regressions failed against the former launcher owner. The repaired source passes **22 checks across five suites**, including eight launcher checks:

```sh
npx vitest run test/linux-shortcuts.test.ts test/linux-autostart.test.ts test/app-identity.test.ts test/bootstrap-secondary.test.ts test/bootstrap-linux-installation.test.ts
npm run verify
```

Public verification passed privacy, notices, TypeScript and production Desktop/Remote builds. A final production rebuild after the last source edit is recorded separately. The test suite and private native evidence remain ignored at the maintainer's request; they must not be added to public Git or release assets.

Private evidence in the canonical checkout:

- `tmp/083-launcher-tests.log`, `tmp/083-verify.log`, `tmp/083-final-build.log`.
- `tmp/083-current-launcher-repair.json`: backups, unchanged profile/process checks and persisted favourite.
- `tmp/083-current-dock.png`, `tmp/083-current-dock-menu.png`: native CUA screenshots, private because they include the maintainer's workspace.
- `tmp/082-final-handoff.json`, `tmp/082-release-audit.json`, `tmp/082-publication-receipt.json`: preceding release evidence. Its “Ubuntu untouched” statement describes the earlier publication task; the narrow subsequent launcher repair is documented above.

Native proof covers the existing Ubuntu session. No logout/reboot, application restart, new package installation, or Windows taskbar test was performed for this follow-up. The fix is mutable application code; the immutable Linux bootstrap was not changed.

## Preparing the next update

1. Read `AGENTS.md`, `docs/ARCHITECTURE.md` and the OneCode maintenance skill. Work in canonical `OneCode/`, inspect branch and dirty state, and preserve unrelated work. Do not develop or publish from the preserved sibling `app/`.
2. Carry `6af893e` into the next release. Do not reconstruct the dock fix in a second launcher owner or change the published 0.8.2 package in place. The next version is not assigned here; use the maintainer's next-update scope.
3. Keep immutable compatibility evidence separate from application version. This change should retain Linux's verified complete **0.8.2** base/runtime `63f9d4c3fbd694b217fabcccb5de917379bf0592be4486a162aade8d59ca9180`; Windows's verified compatible base is **0.5.9**, runtime `0eadd65d501dc6b2f89f08de2bbbeeccc83974d600ab62611412ab0ff340daa4`. Recompute/compare actual candidate receipts before selecting the payload. An app-only repair does not justify a newer minimum complete base.
4. For an authorized new release, align package/lock/main/Companion versions and What's New/release notes, regenerate the Companion stamp, freeze source, then use the existing GitHub workflow on matching runners. Inspect current `stable-release`/`stable-capsule` operation validation before dispatch. Do not compile/upload local installers as the release route. Keep Native-Sources archives excluded.
5. Verify source/tag, both platform jobs, packaged smoke, curated assets, canonical checksums, capsule contents and selected complete-base descriptors. Do not claim a draft or staged download is published or installed.
6. Preserve the installed profile, folder grants, selected browser/provider, connector identity/proof and retained terminal output. Setup recovery from 0.8.2 is evidence-bound and one-shot; do not copy a backup over later user edits or rotate/recreate provider connectors.
7. Any newly authorized native dock acceptance should test add/remove/add, correct grouping, normal shortcut focus of the same process, persistence after the maintainer's chosen restart, and no duplicate menu/dock identity. Preserve other favourites. Do not restart or install on production merely to complete the checklist.

The private Graphify snapshot still describes frozen 0.8.2 source `e52fb29`; it does not contain this launcher follow-up. Refresh it with explicit source provenance when preparing the next release. Preserve existing semantic material and parser limitations; do not publish the graph.

## Earlier scope still requiring native evidence

0.8.1 shared code-block capture/rendering and native Claude widget changes shipped before this hotfix. Desktop Claude formatting and native Windows chart containment had acceptance; this is not exhaustive native ChatGPT/Gemini/Claude parity on Desktop and Remote. The final Remote fullscreen lane was not certified. Reuse the shared renderer and provider adapter owners, and test actual affected provider outputs when the next update touches them.

The earlier Linux Tailscale coordinator outage recovered separately. Do not reset routes or restart Tailscale to investigate dock pinning. The setup-recovery/provider settings work in 0.8.2 has isolated captured-config and bootstrap regression evidence; preserve the maintainer's manual production verification lane and report its results separately.
