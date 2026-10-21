# OneCode changelog

## [0.4.3] — 2026-10-22

Allow slow valid public HTTPS/MCP checks to complete and distinguish timeouts from TLS failures. Enable verified Windows application hotfix bundles through the existing internal updater, with native runtime compatibility checks, coordinated restart and rollback copies. Existing installations receive this enabling release through the normal full installer. See [0.4.3 release notes](docs/release-notes/v0.4.3.md).

## [0.4.2] — 2026-10-21

Add Windows recovery for a Tailscale public TLS failure while the local connector remains healthy. Settings offers Repair public connection, rechecks the owned route, requests Windows consent to restart Tailscale, and verifies public access again. Failed public checks no longer remain labelled Connected. Saved connector URLs, account state, routes and chats are preserved. See [0.4.2 release notes](docs/release-notes/v0.4.2.md).

## [0.4.1] — 2026-10-21

Repair Cloudflare DNS negotiation so either supported DNS resolver can independently verify the public connector when the other resolver is unreachable. This fixes connections stuck at Connecting on affected hotspots for both ChatGPT and Gemini. Saved URLs, Remote routes, permissions and chats are preserved. See [0.4.1 release notes](docs/release-notes/v0.4.1.md).

## [0.4.0] — 2026-10-21

Consolidate permitted local tools, plugins and managed skills under OneCode Core. Add durable interval checks for ChatGPT and Gemini, preserve Remote project composer and delivery ownership, repair native steering and restored browser openings, and automate supported Windows Tailscale setup. Correct image-card recovery and Gemini image export, add inline local photos and playable MP4/WebM videos on desktop and Remote, and recover from transient Tailscale startup/network failures without replaying route changes or messages. See [0.4.0 release notes](docs/release-notes/v0.4.0.md).

## [0.3.6] — 2026-10-19

Unify Gemini and ChatGPT handoff capture around completed Markdown replies without a save-tool approval. Preserve the original task across native manual approval replies, include published tool titles in connector-scoped auto-approval, and repair the fresh Gemini editor remount before warm-up. Add optional native ChatGPT skill export and shorter authorized prompts, preserve late progress placement, and forward native screenshots as images without base64 text overflow. See [0.3.6 release notes](docs/release-notes/v0.3.6.md).

## [0.3.5] — 2026-10-18

Repair desktop compaction and successor authorization on both providers, repeated attachment confirmation, first-message tool access and completed chats remaining Thinking or Active. Reduce Tailscale startup waits and finish provider-neutral status/test-fixture cleanup. Windows x64 internal updates use compatibility version 0.3.500. See [0.3.5 release notes](docs/release-notes/v0.3.5.md) and [installed acceptance](docs/release-acceptance/v0.3.5.md).

## [0.3.4.5] — 2026-10-18

Repair handoff pickup, native provider checkpoints, successor placement, steering and approval-policy isolation. Expose read-only local session history and identify context counts as OneCode estimates. See [0.3.4.5 release notes](docs/release-notes/v0.3.4.5.md).

## [0.3.4] — 2026-10-18

Add the Computer use plugin with official CUA Driver discovery/download and shared-daemon support. Recognize native worker stops and use provider-neutral shared notices.

## [0.3.3] — 2026-10-17

Repair Gemini worker recovery and model selection, account-specific native model discovery, task delivery receipts, connector discovery and Windows update/relaunch. See [0.3.3 release notes](docs/release-notes/v0.3.3.md).

## [0.3.2] — unpublished candidate

Repairs in validation: exact provider-scoped worker attribution, completion through code mode, live tool schemas and discovery, parallel delivery, provider-neutral status, and Windows update/relaunch. See [0.3.2 release notes](docs/release-notes/v0.3.2.md). Publication remains gated on final installed acceptance.

## 0.3.0 — 2026-10-17

See [0.3.0 release notes](docs/release-notes/v0.3.0.md) for provider setup, connector naming, companion and updater fixes, validation and remaining limits.

Earlier changes are recorded in the [GitHub releases](https://github.com/hassanradwannn/OneCode/releases).
