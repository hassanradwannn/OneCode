# OneCode changelog

## [0.6.4 Beta candidate] — 2026-10-25

Recheck running tools when authorizing page recovery, bound connector startup including its initial lifecycle wait, let later explicit sends recover an unanswered browser startup, allow exact-question Stop before an assistant section mounts, separate desktop file-link clicks from model browser-control permissions, and center image-preview dialogs. Native acceptance and stable promotion remain gated on the Beta candidate. See [0.6.4 candidate notes](docs/release-notes/v0.6.4.md).

## [0.6.3] — 2026-10-24

Ship the experimental local OneCode API in the stable application channel after native IDE acceptance. IDE chats are isolated per project/thread, JetBrains retrieval/title helper calls are handled locally, prior client transcript is no longer replayed into durable OneCode history, approved IDE projects bind to OneCode's normal direct filesystem workspace, slash controls work through ordinary chat-completion clients, and Gemini completion waits resolve against the canonical response-turn identity. The release now carries complete Windows/Linux install artifacts for new users alongside smaller runtime-compatible capsules for existing installations. See [0.6.3 release notes](docs/release-notes/v0.6.3.md).

## [0.6.2 Beta] — 2026-10-24

Add an opt-in local OpenAI-compatible OneCode API for IDEs and other same-computer clients. `/new`, `/provider` and `/session` control real durable OneCode chats; chat-completion/Responses requests enter the ordinary desktop input owner so provider turns retain Core tools, permissions, skills, plugins and workers. Add live capability discovery, OS-encrypted persistent per-device authentication, explicit key rotation and a loopback-only disabled-by-default listener. Beta 0.6.2 now carries complete Windows/Linux install artifacts for new users alongside smaller capsules bound to the complete 0.5.7 Beta base; immutable-runtime or channel mismatch still fails closed. See [0.6.2 Beta release notes](docs/release-notes/v0.6.2.md) and [OneCode API](docs/ONECODE-API.md).

## [0.6.1] — 2026-10-24

Make terminal-storage refusals actionable without exposing host paths or retained terminal data. OneCode now preserves the fail-closed boundary while reporting a bounded sanitized storage cause such as access denied, storage full, busy/locked, read-only, I/O error, or an already-safe terminal custody validation failure. The application hotfix retains the verified 0.5.9 complete-base minimum on Windows and Linux. See [0.6.1 release notes](docs/release-notes/v0.6.1.md).

## [0.6.0] — 2026-10-24

Preserve journal failures as recoverable storage errors instead of revoked task authority, verify and migrate default Windows data beside the installation, resume interrupted artifact downloads, reduce Remote startup latency while retaining route custody checks, and improve Linux fonts and download progress. Add a verified GitHub stable-capsule lane against the compatible existing base. See [0.6.0 release notes](docs/release-notes/v0.6.0.md).

## [0.5.9] — 2026-10-24

Repair terminal result delivery and legacy spool recovery, worker reuse across chat handoffs, durable Stop handling, immediate folder grants, journal access failure preservation and Remote history/attachments. The Beta validation release exercised native Windows and Linux internal updates. See [0.5.9 release notes](docs/release-notes/v0.5.9.md).

## [0.5.0] — 2026-10-23

Ship the first full Windows x64 + Linux x64 release, including AppImage/DEB packaging and a verified AppImage application-hotfix foundation. Repair Linux embedded-browser bounds, preserve fresh authenticated Core routing for plans/plugins/sub-agents, add pre-Send image preview, bundle the supported Linux dictation runtime, and carry forward the accepted Tailscale, connector-identity, transcript and long-response reliability repairs. See [0.5.0 release notes](docs/release-notes/v0.5.0.md).

## [0.4.8] — 2026-10-22

Retain the exact unresolved turn for Continue/steering, keep long tool responses alive through the connector, and fail interrupted proxy streams without replaying uncertain work. See [0.4.8 notes](docs/release-notes/v0.4.8.md).

## [0.4.7] — 2026-10-22

Align the previous native-message identity used during steering and receipt tracking, retain the replacement working turn, restore normal 90-second silence recovery, and extend exact authored-input refresh to ChatGPT before first tool use. Preserve one-shot refresh, current-source checks and no Send replay. See [0.4.7 notes](docs/release-notes/v0.4.7.md).

## [0.4.6] — 2026-10-22

Register the exact acknowledged message's turn while its mounted browser bubble is temporarily unreadable, preventing local authorization from waiting for a missing turn. Preserve accepted-Send custody, cancellation and exactly-once registration without resending the task or extending credentials. Upgrade the paired Companion recorder and include the fix in What's new. See [0.4.6 release notes](docs/release-notes/v0.4.6.md).

## [0.4.5] — 2026-10-22

Report hotfix byte progress, pin full-installer downloads to the selected tag, and stage a verified required full release plus its hotfix for one shutdown and final relaunch. Add publisher-verified base metadata and fail closed before installation on mismatched inputs. Ship a complete cumulative installer containing the 0.4.4 What's new pane and earlier connection fixes. See [0.4.5 release notes](docs/release-notes/v0.4.5.md).

## [0.4.4] — 2026-10-22

Restore current release highlights in the existing What's new pane after an update, defer the summary while another dialog is open, and add Settings → General → What's new → View changes for reopening it. Ship the first application hotfix release for compatible 0.4.3 installations without uploading another full installer. Earlier connection recovery and timeout fixes are included. See [0.4.4 release notes](docs/release-notes/v0.4.4.md).

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
