# OneCode next-update handoff

## Current Stable baseline

Stable is **1.2.1**, published November 21, 2026 from frozen source `6a31e25c8e78de600b79098740f4eed7b6b2c82a`. The canonical checkout is `OneCode/` on `release`. The branch can advance with documentation while the published application tag stays pinned. [Release](https://github.com/hassanradwannn/OneCode/releases/tag/v1.2.1) · [Verification report](release-acceptance/v1.2.1.md)

| Platform | Verified minimum complete base | Latest complete package set |
| --- | --- | --- |
| Windows x64 | 0.5.9 | 1.1.6 |
| Linux x64 | 1.0.7 | 1.1.6 |

The 1.2.1 capsule prepares compatible Linux updates before shutdown. Native Ubuntu acceptance confirmed an automatic upgrade from 1.2.0 to 1.2.1, one visible successor and a reconnected Brave Companion on the same profile. This acceptance exercised 1.2.0 as the predecessor. Windows verification covered packaged runtime smoke and artifact integrity. [Build](https://github.com/hassanradwannn/OneCode/actions/runs/44846308345) · [Complete packages](https://github.com/hassanradwannn/OneCode/releases/tag/v1.1.6)

## Next release

1. Inspect the actual checkout, branch, staged paths and latest published release. Preserve shared work and build from the canonical checkout.
2. Recheck the complete-base descriptors and immutable runtime fingerprints. A compatible application-only change uses the Stable capsule workflow on the matching GitHub runners. Changes to the immutable bootstrap or runtime require a complete base.
3. Verify the frozen source, packaged smoke, release assets and checksums before publication. Record installation and visible relaunch evidence separately from build results.
4. Update the README, setup guides and release record when the installation or update behavior changes.

The private Graphify refresh uses the frozen 1.2.1 code. Its local provenance records source and artifact hashes and the remaining parser limitations. Existing document semantics were retained. [Architecture](ARCHITECTURE.md) · [Hotfix workflow](HOTFIX-UPDATES.md)
