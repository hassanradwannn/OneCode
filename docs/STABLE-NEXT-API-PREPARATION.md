# Unfrozen Stable preparation — API integration

Status: **draft, awaiting the user's Beta 0.9.5 testing after the 0.9.4 reliability findings**. This document and the draft integration branch are mutable. They do not approve a Stable source freeze, version reservation, application tag, package build or publication. The Stable `release` branch remains at its existing 0.8.9 lane.

## Prepared scope

Integrate the API work developed from the current Stable ancestry: OpenRouter protected-key setup, model discovery, browserless durable sessions, local Core tools/code mode, plugins, managed skills, broker-owned workers and reuse, live effective/written permissions and exact task recovery. Include the Beta 0.9.4 repairs for immediate Steer, public progress segments, live command/background-process visibility, API readiness/recovery isolation and generated topic titles.

The draft app metadata currently follows the tested Beta candidate (0.9.5); the final Stable version is deliberately undecided. Channel-specific identity, profiles, Companion ports and update selection remain owned by the existing Stable packaging path. No Beta profile, credential or connector URL is copied into Stable.

## Evidence available for review

- Beta 0.9.4 application source: `d86434337e3ca33304110599e036cc7077394037`; later documentation commits do not change its published payload.
- Local broad regression: 700/700 tests across 19 suites, including 329 real-renderer timeline cases.
- Final affected-owner regression: 99/99 tests across API, client, outbox/opening, startup and prompt suites. TypeScript and full public verification passed; Desktop and Remote bundles built.
- An isolated Electron capture verifies the API hint is absent and progress, tool rows, live command captions and background tasks remain visible in order.
- Published [Beta 0.9.4](https://github.com/hassanradwannn/OneCode/releases/tag/beta-v0.9.4) passed [GitHub run 41994981143](https://github.com/hassanradwannn/OneCode/actions/runs/41994981143); all 21 curated assets and compatible-base/payload digests were verified. Details are recorded in the Beta acceptance document. These do not claim installed Stable, signed-in native or physical-device acceptance.

## Actions after user acceptance, before any Stable freeze

1. Incorporate any further Beta comments and repeat the checks for changed owners. Keep this integration draft rather than treating its current SHA as approved Stable.
2. Choose the final Stable version and update its notes, What's New, manifests and package metadata together.
3. Independently verify the published **Stable** complete-base descriptors, native inventories, platform loaders, minimum base versions and checksums. Beta bases/fingerprints are not authority for Stable compatibility. The prepared changes are application code; select compatible capsules and complete fresh-install payloads using the existing release contract.
4. Record the user's Windows/Linux/provider/Remote acceptance and remaining limitations truthfully. API automatic history compaction, attachments and Goal stages remain unavailable in this candidate.
5. Only after the user's acceptance and publication authorization: finalize the `release` source, freeze its exact SHA/tag and dispatch the matching GitHub Stable build. Verify both platforms, curated assets, checksums and update discovery before publishing.

No Stable tag, workflow dispatch, installer activation, profile change or release publication is performed by this preparation.

Beta 0.9.4 user testing found disruptive stop/resend steering and opaque unrecovered API failures. The next candidate adds boundary steering and inference-only recovery. Stable remains explicitly on hold pending acceptance of those repairs; the earlier fixture/build passes did not establish unattended reliability.

Published [Beta 0.9.5](https://github.com/hassanradwannn/OneCode/releases/tag/beta-v0.9.5) is frozen at `fb28d49cde6b60505857e5c0ee83f4acd81eee4b`. [Run 42007505871](https://github.com/hassanradwannn/OneCode/actions/runs/42007505871) passed both platform builds/smoke checks and checksum finalization; all 21 curated assets were verified. This supersedes 0.9.4 as the acceptance candidate and does not grant Stable publication or establish live unattended acceptance.
