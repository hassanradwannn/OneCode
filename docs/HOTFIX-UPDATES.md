# Windows application hotfix updates

OneCode 0.4.3 introduces application-only updates through the existing internal update owner. Users on 0.4.2 or earlier first install the complete 0.4.3 release through Settings. Future compatible releases use the same Check for updates and Install when done actions, with a smaller download and a coordinated restart.

## Publish a compatible hotfix

From the canonical checkout, increment the normal three-part application version and matching Companion version. Run the relevant tests and public verification, then:

```powershell
npm run dist:dir:x64
npm run release:hotfix
```

The directory build runs the packaged runtime smoke check without assembling NSIS. The publishing command creates `OneCode-Hotfix-x64.zip`, `OneCode-Hotfix-x64.json` and a matching `SHA256SUMS.txt`. Publish those three files to the ordinary GitHub release for that exact version. Do not upload a leftover installer from release/. The standalone command replaces the checksum list so it cannot accidentally advertise an old installer. A full Windows release's preparation command includes both the installer and the hotfix assets.

The capsule is a complete snapshot of allowed application resources, not a binary delta. It contains app.asar, Companion, bundled skills, updater helpers, setup text and third-party notices. It cannot replace Electron, Node, native modules, tunnel binaries, private profiles or credentials. Every manifest entry has an exact path, byte count and SHA-256; the archive and manifest also match the release checksum list. The trust source is the configured OneCode GitHub publisher over HTTPS, as with the existing installer updater; an independent code-signing signature is not claimed.

## Runtime compatibility and activation

The Windows after-pack hook records an immutable resource inventory and the exact Electron version in resources/updater/runtime.json. A capsule is selected only when its architecture and runtime fingerprint match the installed baseline. The detached helper verifies the actual native resources again after canonical shutdown. A change to that runtime requires a full installer. If a hotfix-only release is incompatible, the updater offers the release page rather than attempting a replacement; link the required complete base release in its notes.

The main update owner verifies and expands the archive into its versioned cache, refusing traversal, links, case aliases, unexpected entries and oversized data. Explicit Install when done retains the current version/work fences and durable shutdown. The helper runs from a copied Node runtime outside the install, checks the registered target, saves rollback copies and replaces only allowed files. Removed application files are retired as part of the snapshot. Success requires the new application to log its expected version and keep a loaded visible window alive.

Failures before a successor runs restore the verified previous snapshot. A successor that is still running but cannot be confirmed is left alone and its rollback copy is retained; the helper never kills potentially active user work. Rollback backups remain in the private update cache. A forced shutdown or power loss during replacement requires recovery from the retained backup or a full installer; automatic replay of an uncertain update is not claimed.
