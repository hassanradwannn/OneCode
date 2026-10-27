# OneCode — working map

OneCode is a provider-generic Electron desktop workspace for browser AI providers and local tools. ChatGPT web and Gemini web are the currently implemented adapters. Neither provider defines the product. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), then the relevant implementation before editing. Historical Gemini Code and Chat On Steroids names in modules, compatibility variables and old worklogs do not describe the current product scope. `docs/UPSTREAM-ARCHITECTURE.md` is a historical upstream reference.

## Working rules

The tree is shared and dirty. Never reset, clean, overwrite unrelated edits or edit the reference upstream checkout. Repair the earliest wrong ownership boundary. Do not add guessed identity, a mirrored authority or automatic mutation replay. Source, package, installed app and live-browser evidence are different facts. Report actual validation and unresolved limits.

The Stable release lane is `release`. Inspect Beta/platform ancestry before selecting repairs. Published tags remain immutable; later documentation commits need not match the packaged source commit. Generated `graphify-out/` is private navigation evidence: record its source revision, source hashes and parser limitations, and keep it out of public Git.

User authorization in this chat controls task scope. Reversible development and scratch testing require no additional confirmation. Publication and external account actions follow the user's explicit instructions. Do not publish a candidate while requested repairs remain unfinished.

## Runtime and providers

- Product/package: OneCode / `onecode`; app ID: `io.onecode.desktop`. `src/main/app-identity.ts` owns identity and profile migration. Resolve the effective profile from that owner and the running installation: normal Windows launches can use a private per-user `OneCode Data` sibling or fallback, while legacy profiles and explicit environment overrides are retained. Never replace the user's profile to fix a release.
- `package.json`, `src/main/version.ts` and `extension/manifest.json` own current source versions and bridge compatibility. A source version does not prove publication or installation.
- Each installation owns its connector URLs, credentials, pairing and durable state. Provider MCP endpoints are separate. Connector names include the user's configured device suffix; never hard-code a maintainer's device or another installation's URL.
- `src/shared/chat-provider.ts` owns provider identities, conversation parsers, URLs, capabilities and trust lookup. New chats use the selected provider. Existing chats and workers retain their provider through stored conversation/family identity. Changing the selector cannot reinterpret them.
- Shared UI and status messages say provider, agent or chat. Use service names only for a provider picker, native service setup, or an actual adapter constraint. Do not globally rename adapter APIs or compatibility fields to change copy.
- Fresh installs enable read only. Workers and unattributed calls are separate opt-ins. Enabling unattributed calls cannot authorize worker families or substitute for an exact parent session.

## Owners and invariants

- `session/input.ts`: durable outbox, exclusive claim, pre-Send authorization and exact native ACK/history receipt. Insertion is not Send. An ambiguous authorized send is never automatically replayed.
- `bridge.ts`, `extension/background.js`, `content.js`: paired transport, elected documents, command leases, worker bootstrap and receipts. One owner may click Send. Parallel chats hold separate claims; no global prompt queue may serialize independent work.
- `extension/chatgpt-dom.js` and `fiber.js`: ChatGPT native UI and rendered conversation observations. `extension/gemini-dom.js`, `gemini-markdown.js`, `gemini-routing.js`: Gemini native UI and account/document routing. Native provider differences belong in these adapters.
- `mcp/server.ts`, `inbound.ts`, `call-context.ts`, `kernel.ts`: endpoint provider, request-scoped attribution, permissions, Block/Trust, nested code-mode inheritance and recording. Native request IDs are evidence only when exactly joined to companion observations. RPC IDs, active tabs, timing and mutable new-chat settings are never caller identity.
- `gemini/bindings.ts`: hash-only, durable, revocable local capabilities for exact durable Gemini attachments. Worker warm-up grants are dormant until the real task ACK. Input grants require the canonical input/turn. Elapsed time does not revoke valid task authority. Never fabricate Google request IDs or move Resume during warm-up.
- `session/local-binding.ts`: durable installation-bound ChatGPT task capabilities when native request correlation is absent. Grants refer back to the original outbox claim or worker command receipt; the ledger owns no conversation identity. Ingress consumes credentials before strict tool validation or recording. Restart preserves grants whose exact durable task proof remains valid; superseded, revoked and unprovable grants fail closed. Do not describe these as provider-authenticated request IDs.
- Existing `agents.ts`, recorder, store, correlation, continuation and broker owners retain worker families, history, turns and processes. Exact ownership is preserved across concurrent calls. Unknown identity fails closed for identity-sensitive operations.
- `plugins/manager.ts` owns installed tools and live policy. Core `plugins` is discovery/dispatch through that owner; never search a marketplace as proof of locally installed tools. Nested plugin calls inherit the validated caller and cannot claim that another native connector was used.
- `skill-library.ts` owns live local skill metadata. `/skills/.catalog.json` is a virtual read alias with ordinary read permission and validated workspace scope. Read relevant returned `SKILL.md` bodies; selected revisions freeze at existing preparation boundaries.
- `projects.ts` and sandbox roots own workspace scope. A project association grants no new filesystem permission. A worker's verified allocated checkout, when present, is its working directory; source project AGENTS supplies instructions only.
- `update.ts`, `update-all.ts`, `resources/updater/windows-update-helper.cjs`: verified download, durable update intent, shutdown handoff, installation and visible relaunch. Do not equate spawning an executable with a loaded visible window. Internal updates preserve the normal profile and user history.

## Browser and tool boundaries

Use native provider UI for signed-in browser behavior. No private provider APIs, cookie copying, fabricated quota, guessed ownership, or automatic mutation retries. Local setup/control endpoints project existing owners; they are not an alternate browser execution path.

Background rendering leases attach only to the exact owned tab and use bounded focus emulation. Never add DOM/Runtime/Network/input debugger commands to that owner. Honor Chrome permission/cancellation. Automatic work uses ordinary managed windows without stealing OS focus; explicit user Open reveals its chat.

Gemini native menus must prove a newly rendered exact connector/skill token. Optional skill warm-up may fall back only with its original unchanged draft, route and lease. A reference is not proof a skill loaded. Native approval auto-handling requires the exact enabled OneCode connector and its current tools; another app, disabled card, unknown layout or generic Allow text supplies no authority.

Goal/Loop/Steer, helper chats, native finals, silent recovery and Compact & Resume retain their current exact turn/receipt guards. Interim prose, a missing card, or zero calls between requests does not prove completion. Old request-null Gemini evidence remains local binding proof, not a provider identifier. Capability evidence and restored tool-result receipts must retain provider, grant incarnation, session and turn.

## Validation and shipping

Normal app releases do not attach the large `OneCode-Native-Sources.tar.gz` archive or its separate checksum. The user explicitly excluded it. Preserve third-party notices and use the existing matching source reference when the native inventory is unchanged. Do not dispatch the native-source publishing workflow for an ordinary app release.

The test suite, Vitest configuration, manual UI test scripts and their fixtures are maintained locally and ignored by Git at the user's request. Preserve those files when changing tracking. `npm test` uses that local suite; public `npm run verify` checks source prerequisites, privacy, notices, TypeScript and the production build without requiring unpublished tests. Public release acceptance documents retain the historical validation scope.

Run meaningful focused tests for changed owners, TypeScript, build, packaged runtime smoke and relevant Electron UI checks. Repair obsolete fixtures without mass-skipping tests or weakening production behavior to claim parity.

Signed-in native acceptance uses the user-requested CUA driver CLI. Do not substitute another computer-use surface or bypass daemon consent. Root owns the signed browser; bounded workers must not race it. During broad acceptance, at most two direct independent fix workers may run; no nested agents.

After extension edits, use `scripts/write-extension-stamp.mjs`. Rebuild and repackage after final source changes, then run `scripts/smoke-packaged-runtime.mjs --platform win32 --arch x64`. Preserve notices/licenses, privacy guards and unrelated dirty files. Never publish an old package as containing newer source. Keep private URLs, credentials, local acceptance artifacts and user history out of the public checkout.

Native output parity requires actual adapter/export acceptance. Gemini image previews and rendered PNG export have Windows acceptance; that does not prove original-file export, native video generation or native Canvas parity. Core local image/video presentations are a separate provider-independent path. Do not claim feature parity merely from provider-generic terminology.

## Incomplete chat synchronization

Compare the exact native public reply, canonical message shards, history/live read-model response and selected renderer separately. Record message/question/turn IDs, content digests, origin versus revision sequence and capture times. A complete saved reply does not prove that the desktop or Remote view applied it. Conversely, a stale screenshot does not prove capture loss. Include native writing/document envelopes and late revisions in parity checks. Diagnose the first mismatch without replaying the user's task, replacing history, or operating the production workload shown inside the chat.
