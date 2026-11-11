# OneCode changelog

## [1.0.81] — 2026-11-11

Ship the ChatGPT-generated diagram support as a direct application update for Windows installations using the compatible 0.5.9 complete base and Linux installations using the compatible 1.0.7 base. See [1.0.81 notes](docs/release-notes/v1.0.81.md).

## [1.0.8] — 2026-11-11

Preserve ChatGPT-generated grids, diagrams and standard HTML controls as safe offline previews instead of flattening their visual layout into transcript text. See [1.0.8 notes](docs/release-notes/v1.0.8.md).

## [1.0.7] — 2026-11-10

Keep Gemini attachment sends moving through preview redraws and report a stopped send while preserving the draft. See [1.0.7 notes](docs/release-notes/v1.0.7.md).

## [1.0.6] — 2026-11-10

Keep OneCode-sent attachments from appearing twice, use Claude’s native working status for the current question, and restore missing strokes in Claude diagrams. See [1.0.6 notes](docs/release-notes/v1.0.6.md).

## [1.0.5] — 2026-11-10

Support both Claude Send button layouts and keep the staged document when Claude replaces its loading preview. See [1.0.5 notes](docs/release-notes/v1.0.5.md).

## [1.0.4] — 2026-11-10

Restore PDF and document delivery in Claude’s nested composer layout. OneCode finds the active composer’s upload input and transfers the files directly. See [1.0.4 notes](docs/release-notes/v1.0.4.md).

## [1.0.3] — 2026-11-10

Paste photos into Claude’s composer, recognize Claude’s timestamp-prefixed filenames, and reconcile late native delivery receipts. See [1.0.3 notes](docs/release-notes/v1.0.3.md).

## [1.0.1] — 2026-11-09

Recognize Claude’s current attachment strip so a staged file can reach native Send and an existing attachment stays with its original draft. See [1.0.1 notes](docs/release-notes/v1.0.1.md).

## [1.0.0] — 2026-11-09

Paste attachments directly into Gemini and use native Send as soon as the staged draft is ready in Gemini and Claude. See [1.0.0 notes](docs/release-notes/v1.0.0.md).

## [0.9.10] — 2026-11-09

Fix attachment delivery in Claude and Gemini and restore previews for images sent directly in Claude. See [0.9.10 notes](docs/release-notes/v0.9.10.md).

## [0.9.9] — 2026-11-09

Restore browser-sent images, copyable prompts, image gallery captions and Claude diagram colors. Show the OpenRouter daily free-request count in Usage when available. See [0.9.9 notes](docs/release-notes/v0.9.9.md).

## [0.9.8] — 2026-11-09

Keep active API turns running through brief Windows checkpoint locks, bound OpenRouter’s wait for response headers, and improve authored links, image previews and copied prompts. See [0.9.8 notes](docs/release-notes/v0.9.8.md).

## [0.9.7] — 2026-11-09

Import an existing standalone HTML file directly, clarify artifact handoffs after context compaction, and restore the per-model OpenRouter effort slider. See [Stable notes](docs/release-notes/v0.9.7.md).

## [0.9.6] — 2026-11-09

Isolate Workbench browsers by chat, import standalone web builds directly, load per-model OpenRouter reasoning levels, allow larger concurrent worker batches in automatic mode, and wait for active API work before installing. See [Stable notes](docs/release-notes/v0.9.6.md).

## [0.9.5] — 2026-11-08

Present supported OpenRouter web builds as inline artifacts and open live Vite sites in their chat’s Workbench. Reuse the dedicated Brave window and restore imported image cards and code blocks. See [Stable notes](docs/release-notes/v0.9.5.md).

## [0.9.4] — 2026-11-08

Isolate managed browser windows, preserve parallel Claude chats and skip silent recovery while ChatGPT is still streaming. Restore portable scorecards and grading charts, highlight code in Desktop and Remote, and retain each OpenRouter chat’s accepted model. Restrict packaged build output to app directories. See [Stable notes](docs/release-notes/v0.9.4.md).

## [0.9.3] — 2026-11-07

Continue Claude upload observation through bounded composer remounts and recover completed images when composer-wide readiness fields are absent. Preserve native skill identity when an existing question hydrates. Report upload failure stages and refresh the recorder and native reader in open tabs. See [Stable notes](docs/release-notes/v0.9.3.md).

## [0.9.2] — 2026-11-07

Expose OpenRouter model input capabilities and send supported photo, PDF, text, audio and video attachments. Validate capabilities before dispatch and separate media transport bytes from text context estimates. Keep raw media out of compaction summary requests. Recover exact Claude attachment questions from split media/text layouts and commit their native receipt independently of transcript flushing. Remove stale Beta wording from API delivery errors. See [Stable notes](docs/release-notes/v0.9.2.md).

## [0.9.1] — 2026-11-06

Keep API outbox rows out of native browser publication, claims and opening-lease projections. Recheck the resolved target transport, and reject non-browser/unknown providers or API conversation IDs in Companion delivery before querying or opening tabs. Preserve normal browser-provider delivery and local API execution. See [Stable notes](docs/release-notes/v0.9.1.md).

## [0.9.0] — 2026-11-06

Promote the complete Beta 0.9.0–0.9.11 repair series to Stable: opt-in OpenRouter sessions and model discovery; provider-generic local tools, code mode, plugins, skills and workers; live effective/written permissions and exact task credentials; boundary steering and inference-only recovery; visible commands/background work; terminal publication acknowledgment; model-aware output and request budgets; earlier topic names; Claude attachment/draft/transcript handling; discoverable sidebar browsing; Setup navigation; and archived API context compaction with validation recovery and the normal Desktop Compact & Resume card. Preserve Stable/Beta profile and updater isolation. See [Stable notes](docs/release-notes/v0.9.0.md).

## [0.9.11 Beta] — 2026-11-05

Present API context compaction through the existing Compact & Resume card, with durable archive, summary, retry, save and actual request-accepted resume stages. Separate pre-Send recovery information from delivery errors. Retry invalid summary output up to three attempts per part, progressively requesting shorter handoffs and expanding truncated/empty output budgets within the model ceiling. Keep typed failure reasons and content-free diagnostics, exact archives, cached valid parts and existing task/process ownership. See [Beta notes](docs/release-notes/beta-v0.9.11.md).

## [0.9.10 Beta] — 2026-11-05

Add local checkpointed API context compaction at model/tool boundaries, bounded hierarchical handoff summaries and recovery of typed upstream context rejections. Verify and retain the original source archive before atomically replacing working context. Preserve the first/latest user messages, complete recent tool exchanges, unacknowledged output pages and existing turn/process/worker ownership. Support manual Compact context for idle/failed chats and queued compaction for live tasks; honour the automatic-compaction toggle. Show compaction progress and the effective saved-context estimate. Disable OpenRouter's middle-out truncation so the local receipt owner knows which tool results were actually delivered. See [Beta notes](docs/release-notes/beta-v0.9.10.md).

## [0.9.9 Beta] — 2026-11-05

Keep Setup's provider picker and API-key form reachable for OpenRouter. Exclude hidden transport steps from active-step and completion calculation, show the API Next action and use saved secure-key readiness independently of browser/tunnel state. Provider switches stay on their setup page; Back from Folder reaches the provider form. Add a visible Back to chats exit. See [Beta notes](docs/release-notes/beta-v0.9.9.md).

## [0.9.8 Beta] — 2026-11-05

Read a native Claude question's sole exact plain text item alongside media without importing media payloads. Suppress lossy app-frame readback until exact source or structured-chip proof is available, and recover historical chip presentation without creating Send authority. Preserve an upload's exact draft across one editor remount, accept positively settled tiles and re-read delayed upload observations without uploading again. Request API titles at the first validated response, reject directory-style metadata and upgrade older folder names once while preserving manual names. Make the Workbench browser discoverable before a manual tab exists and reveal an authorized new tab only in its selected chat. See [Beta notes](docs/release-notes/beta-v0.9.8.md).

## [0.9.7 Beta] — 2026-11-05

Raise the local API JSON transport limit from 2 to 16 MiB and the durable thread allowance from 6 to 32 MiB, independently of model context limits. Preserve existing chat history, tool outcomes and ownership. Share validated model definitions between the UI and runtime using the existing catalog owner, with expiry, explicit refresh, credential invalidation and independent cancellation. Show pending preparation/provider-wait stages and record safe per-phase timing/byte metadata without fabricating delivery receipts. See [Beta notes](docs/release-notes/beta-v0.9.7.md).

## [0.9.6 Beta] — 2026-11-05

Use model/context-aware API response budgets and automatically continue length-truncated responses without executing incomplete tool proposals. Repair API terminal result publication and acknowledgement, carry normal terminal renderings without the former 12K-character clip, and re-offer unacknowledged restored prefixes. Preserve session/incarnation ownership and incomplete/failed delivery. Detect unchanged exec-refusal loops across model decisions and guide owned hung-process interruption without launching another command. See [Beta notes](docs/release-notes/beta-v0.9.6.md).

## [0.9.5 Beta] — 2026-11-05

Keep API tasks alive through steering and recover transient inference failures from saved tool results. Respect provider retry delays, show reconnecting/recovered status and safe HTTP/transport failure explanations, and retain running processes. Apply direction changes at model/tool boundaries without aborting inference or dispatched tools; explicitly skip proposals not yet executed. Extend long-task bounds beyond the earlier twenty-step cap. Stable remains an unfrozen draft pending user acceptance. See [Beta notes](docs/release-notes/beta-v0.9.5.md).

## [0.9.4 Beta] — 2026-11-05

Make API Steer interrupt the exact current generation instead of silently queuing. Preserve in-flight tool receipts and background-process custody. Publish separate public progress segments around tools, trailing streaming updates and exact live command activity. Use API runtime activity in Desktop/Remote projections and keep API chats out of browser readiness/recovery. Generate short topic titles with a bounded tool-free request; protect manual names and do not retry uncertain metadata requests. Include exact schema feedback after rejected arguments and stronger workspace/artifact guidance. Stable preparation remains an unfrozen draft pending user acceptance. See [Beta notes](docs/release-notes/beta-v0.9.4.md).

## [0.9.3 Beta] — 2026-11-05

Add a shared local API harness and adapter interface. OpenRouter can spawn, report and reuse broker-owned workers, compose Core tools, call installed plugins and import/read managed skills without a browser. Recheck live grants and Read-only; retain exact turn identity through nested calls and cancellation. Restore API model IDs and never repeat uncertain API requests after restart. Direct written capability grants update the existing settings owner. Recheck transient task attachments at handler admission and recognize an exact credential after leading whitespace. Stable remains 0.8.9; real-provider and installed acceptance remain pending. See [Beta notes](docs/release-notes/beta-v0.9.3.md).

## [0.9.2 Beta] — 2026-11-05

Separate OpenRouter API readiness from browser-extension warnings without disconnecting existing browser-provider sessions. Attach OneCode API tool events to their exact turns, report the selected model route, use model-catalog context estimates instead of a global reference, and stop labeling unavailable API automatic compaction as active. Raise the previously restrictive completion budget for capable models and distinguish API truncation from browser errors. Improve first-turn tool-availability instructions across providers and briefly recheck a temporarily ambiguous task attachment after refresh, preserving strict credentials and revocations. Full signed-in native acceptance remains pending. See [Beta notes](docs/release-notes/beta-v0.9.2.md).

## [0.9.1 Beta] — 2026-11-04

Correct OpenRouter Setup to prompt directly for an API key instead of browser/extension installation. Save and remove keys through protected credential storage, invalidate model discovery after key changes, and offer the openrouter/free routing model when no exact model is selected. Preserve OpenRouter reasoning metadata in subsequent API messages without displaying it as an answer; retain OneCode local tool/session permissions. The free route uses an explicitly estimated local context budget because its upstream model varies. This remains an experimental Beta with live-provider acceptance pending. See [Beta notes](docs/release-notes/beta-v0.9.1.md).

## [0.9.0 Beta] — 2026-11-04

Experimental OpenRouter API provider with OneCode-owned sessions, model discovery, local tool calls, and bounded request handling. Repair late native acknowledgment during automatic ChatGPT turn rotation without relaxing task capabilities; preserve distinct prior/new credentials across live and restarted sessions. This is a Beta prerelease for Windows and Linux testing, not a Stable release. OpenRouter automatic context compaction and signed-in native acceptance remain pending. See [Beta notes](docs/release-notes/beta-v0.9.0.md).

## [0.8.9] — 2026-11-03

Approve existing native paths explicitly supplied in trusted Desktop/Remote user messages through the existing root owner. Preserve exact-file scope, folder contents, canonical path validation, existing aliases, revocation and capability settings. Remote resolves recorded ChatGPT sandbox links to their native chat on the phone, handles blocked popups visibly and hides inline provider reference markers. Full Windows/Linux packages and compatible capsules ship together. See [notes](docs/release-notes/v0.8.9.md) and [acceptance](docs/release-acceptance/v0.8.9.md).

## [0.8.8] — 2026-11-02

Use the unique native uploader owned by Claude's current form/dock on fresh and existing pages. Retain the prompt when attachment confirmation fails instead of clearing it while leaving the file/error behind. Preserve exact upload-state proof and one-shot dispatch; no uncertain task is resent. Companion protocol 22 is unchanged and recorder 127 refreshes the adapter/content pair. Full Windows/Linux packages and compatible capsules ship together. See [notes](docs/release-notes/v0.8.8.md) and [acceptance](docs/release-acceptance/v0.8.8.md).

## [0.8.7] — 2026-11-02

Wait up to thirty seconds for Gemini's initial model picker and exact native connector entry to load, retaining draft, route, cancellation, native model selection and connector token checks. Publish complete Windows/Linux installations and compatible cumulative capsules from the same frozen source. Companion protocol 22 is unchanged; recorder 126 replaces the loaded adapter/recorder pair. See [release notes](docs/release-notes/v0.8.7.md) and [acceptance](docs/release-acceptance/v0.8.7.md).

Retain completed Gemini approval receipts across refresh to veto another click, reject approval-only final footers, and project the native composer usage-limit strip. Recognize an exact Claude selected-skill task when its visible chip collapses, recheck a native final before silence navigation, and distinguish unchanged effort from an explicit Low endpoint choice.

## [0.8.6] — 2026-11-01

Recover exact accepted continuation receipts after a lost browser acknowledgement, retain one-shot page recovery through replacement readiness, and handle ChatGPT's native account-change Retry during an owned fresh opening. See [release notes](docs/release-notes/v0.8.6.md) and [acceptance](docs/release-acceptance/v0.8.6.md).

## [0.8.5] — 2026-10-31

Keep the trusted Windows Tailscale repair available across connection states while preserving saved routes and settings. See [release notes](docs/release-notes/v0.8.5.md) and [acceptance](docs/release-acceptance/v0.8.5.md).

## [0.8.4] — 2026-10-30

Carry the 0.8.3 reliability repairs into a new acceptance candidate. Activate the current ChatGPT picker through its native click, default empty discovery helpers to Chat mode, avoid unnecessary picker mutations for an exact account-available selection, and keep response identifiers reused across Steers from moving commentary above its correction. Restore the in-app connection dot and identify OneCode in the Windows tray. Show plugin installation progress, explicit completion/error state and visible setup instructions; export Blender MCP's verified matching bundled add-on through a Save dialog. Companion protocol 22 and recorder 119. See [release notes](docs/release-notes/v0.8.4.md) and [acceptance](docs/release-acceptance/v0.8.4.md).

## [0.8.3] — 2026-10-30

Restore progressive long-chat import and remove the premature 400 KiB native-observation cutoff, preserve Steer receipts until delivery ACK, keep late historical questions from replacing current task identity, recover Compact & Resume only after a replacement provider document is actually ready, keep fresh-chat model verification stable across provider ID churn without weakening native proof, keep Steer anchored at its insertion point, repair provider code-block capture, brand the sidebar connection state as OneCode, and carry the verified Linux dock-identity follow-up. Companion protocol 22 and recorder 118 force older loaded browser code to reload the new contracts. See [release notes](docs/release-notes/v0.8.3.md) and [verification scope](docs/release-acceptance/v0.8.3.md).

## [0.8.2] — 2026-10-30

Repair Linux duplicate-launch rollback before it can fall back to an older application and reset setup. Preserve desktop launcher identity, recover validated settings from proven downgrade resets, and recognize saved exact-route connector evidence after restart. Linux needs one complete package to replace its immutable bootstrap; Windows retains its compatible capsule path. See [release notes](docs/release-notes/v0.8.2.md) and [verification scope](docs/release-acceptance/v0.8.2.md).

## [0.8.1] — 2026-10-30

Retain existing task identity through native refresh and reconnect, and reject historical completed footers as proof that a newer Gemini or Claude task ended. Capture exposed native inline diagrams, fit expanded charts within the screen, and preserve code blocks inside native lists and quotations. Show update bytes and verification/preparation phases, and distinguish Tailscale network waits from failed Funnel permission checks. Both platform builds retain compatible 0.5.9 bases. See [release notes](docs/release-notes/v0.8.1.md) and [verification scope](docs/release-acceptance/v0.8.1.md), including pending native acceptance.

## [0.8.0] — 2026-10-29

Add a third provider to new chats, Setup, Remote and the local API while preserving existing chat and worker identity. Discover account-available current/legacy models and effort metadata, guide custom MCP and optional native skill installation, and show observed account-limit resets without task replay. Extend exact local capability authorization and retained state to the added adapter. Render React/TSX components with bundled Tailwind, Lucide and Recharts inside the existing network-closed preview. See [release notes](docs/release-notes/v0.8.0.md) and [verification scope](docs/release-acceptance/v0.8.0.md).

## [0.7.4] — 2026-10-29

Support both native ChatGPT picker layouts, default new chats to Chat while retaining explicit Work choices, add Gemini Thinking levels and recheck its exact model after warm-up. Reduce avoidable preparation delays and repair a pending-frame Steer race. See [release notes](docs/release-notes/v0.7.4.md) and [verification](docs/release-acceptance/v0.7.4.md).

## [0.7.3] — 2026-10-28

Repair retained WSL custody cleanup and validate update preparation before shutdown, preventing a Windows update from exiting without reaching its install/relaunch handoff. See [release notes](docs/release-notes/v0.7.3.md) and [verification](docs/release-acceptance/v0.7.3.md).

## [0.7.2] — 2026-10-28

Improve guided public-connection setup, idle browser delivery, exact task authorization and steering state while preserving uncertain-send guards. See [release notes](docs/release-notes/v0.7.2.md) and [verification](docs/release-acceptance/v0.7.2.md).

## [0.6.17] — 2026-10-26

Keep proved Gemini approval replies attached to their original task while partial chat history loads, and wait for approval receipts before confirming refresh readiness. Includes the Steer/local-poll and queued-follow-up repairs, durable authorization for long Compact & Resume tasks, independent chat pickup, native host pairing, Companion coexistence and updater cleanup fixes. Complete Windows/Linux downloads and compatible application capsules are built from one frozen source; Stable capsules retain the verified 0.5.9 minimum complete base. Automatic approval changes remain deferred. See [0.6.17 release notes](docs/release-notes/v0.6.17.md) and [acceptance](docs/release-acceptance/v0.6.17.md).

## [0.6.6 Beta candidate] — 2026-10-25

Keep Companion discovery and pairing on the browser's native OS when WSL forwards another installation's loopback listener. Refuse foreign-OS authenticated actions before processing observations or changing credentials. Preserve pairing through a transient native-platform lookup failure. Includes the 0.6.4 and 0.6.5 recovery, Stop/restart, startup, downloads and preview fixes. Native acceptance and stable promotion remain pending. See [0.6.6 candidate notes](docs/release-notes/v0.6.6.md).

## [0.6.5 Beta candidate] — 2026-10-25

Let a fresh explicit message restart the chat after confirmed native Stop without waiting for the old activity timer; earlier queued work and automation remain held. Bound asynchronous OS credential-storage calls so an unanswered keyring prompt cannot prevent the first window or hold state reads indefinitely. Preserve ciphertext and installation identity, discard late results, and avoid stacking native calls behind the same prompt. Includes the 0.6.4 recovery, Stop, browser-startup, file-link and preview fixes. Native acceptance and stable promotion remain pending. See [0.6.5 candidate notes](docs/release-notes/v0.6.5.md).

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
