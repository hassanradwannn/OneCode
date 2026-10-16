# Multi-provider compatibility audit

This is the release checklist for every browser AI provider added to OneCode. It records the
provider mismatches found while adding ChatGPT beside Gemini in v0.2.8. Keep it current when a new
provider is designed, implemented, tested, or removed.

## Contract that every provider must satisfy

A provider adapter must define all of these before it can be enabled in Settings:

- stable provider key, display name, allowed origins, home URL and conversation URL;
- exact conversation-ID parser and URL-to-conversation parser;
- browser DOM adapter for composer, Send/Stop state, answer boundaries, models, attachments,
  approvals and native error states;
- receipt strategy for proving that a message was accepted and which conversation owns it;
- handoff strategy, maximum safe message size and Markdown preservation rules;
- connection/plugin setup route and schema-refresh behavior;
- project/deep-link support, generated-image export, temporary chats and account/profile routing;
- provider-specific trust-validation switch and exact trusted/blocked identity validation;
- setup copy, diagnostics, extension permissions, updater compatibility and a signed-in acceptance
  matrix for new chats, existing chats and live provider switching.

New chats use the provider selected in Settings. An existing chat always derives its provider from
its stored conversation identity. Changing the selector must not reinterpret, migrate, close or
reopen an existing chat.

## Fixed in the Gemini + ChatGPT implementation

- `src/shared/chat-provider.ts` owns provider keys, conversation identity, URLs, labels,
  capabilities and trust-setting lookup.
- `src/main/session/start-input.ts`, `src/main/bridge.ts`, `src/main/browser.ts` and
  `extension/background.js` route new work by the selected provider and existing work by stored
  identity. Saving the provider wakes the browser bridge; no app restart is required.
- `extension/manifest.json` loads a dedicated DOM adapter for both providers from one extension.
- The MCP tool surface stays stable while switching. Unsupported native features are capability
  gated instead of adding/removing tools and forcing connector recreation.
- Trust validation is independent per provider through
  `multiAgent.strictChatAllowlistByProvider`. Old configs migrate from the previous global value.
  Trusted and blocked conversation IDs are still exact identity records, so a provider switch does
  not grant another chat access.
- Setup and Plugins routes, labels and instructions repaint from the active provider.
- Provider-specific handoff and receipt types are recorded in continuation provenance.

## Known binary assumptions to remove before a third provider

### Shared provider registry

`src/shared/chat-provider.ts` currently uses a closed `gemini | chatgpt` union and binary branches.
Adding a provider requires an explicit registry entry. Never let an `else` branch mean ChatGPT or
Gemini; unknown providers must fail closed.

`extension/background.js` duplicates provider keys, home URLs, host parsing and conversation URL
parsing because the MV3 worker cannot import the TypeScript module. Update it from the same provider
spec or generate the browser copy during build. A new provider is incomplete until both registries
agree.

### Browser DOM and delivery state machine

`extension/content.js` still contains many `CLF_DOM.provider === 'gemini'` and
`CLF_DOM.provider !== 'gemini'` branches. The second form currently means ChatGPT. Replace binary
branches with named capabilities/adapter methods before enabling a third provider, especially for:

- composer authorship and draft replacement;
- new-chat bootstrap claims and accepted-Send receipts;
- Stop/generating recovery and automatic reload;
- approval cards and native question ownership;
- goal drafts, helper/temporary chats, attachments and Compact & Resume.

Each new site needs its own `<provider>-dom.js`. Do not copy selectors into shared `content.js`.
Provider DOM changes must fail closed when a native control or message boundary is ambiguous.

### Receipts, handoffs and correlation

`src/main/bridge.ts`, `src/main/session/continuation.ts`, `src/main/session/handoff.ts` and
`extension/content.js` currently distinguish Gemini's native-question/document custody from
ChatGPT's Fiber/question receipt with binary branches. Extend the discriminated receipt union;
never route a new provider through the ChatGPT `else` path.

The main caller context still exposes names such as `geminiBinding`, and
`src/main/gemini/*` is a Gemini-specific binding implementation. A future provider needing a local
session capability must get a separate provider binding type or a neutral provider-binding union.
Prompt text, model-authored IDs and the selected tab are not proof of ownership.

### Conversation identities and routes

Gemini uses a 16-hex conversation ID. ChatGPT accepts its current alphanumeric/hyphen route ID.
All security boundaries must call `isChatProviderConversationId` with the proven or derived
provider. Do not add another broad shared regex.

Hard-coded site routes remain in `extension/gemini-dom.js`, `extension/gemini-routing.js`,
`extension/chatgpt-dom.js`, `extension/background.js`, `src/main/gemini/*` and
`src/shared/cos-browser-sites.ts`. A provider must declare every allowed origin and reject
cross-origin redirects before any input is sent.

### Browser and account profiles

`ui.chatBrowser` is still one default browser for all new providers. Existing chat ownership keeps
working across a switch, but a future release may need `chatBrowserByProvider` when accounts live in
different browser profiles. Do not silently move an existing chat to the newly selected browser.

Gemini understands `/u/<number>` account paths through `extension/gemini-routing.js` and
`src/main/gemini/bindings.ts`. ChatGPT currently has no equivalent multi-account route model. Every
new provider needs an explicit account/profile identity policy before background reuse is allowed.

### Projects, plugins and setup

Native project metadata still uses the field name `chatgpt` in project records and links. Generalize
this to a provider-keyed link map before a second provider supports native projects.

Plugin/connector setup differs by provider:

- Gemini uses Connected apps and an HTTPS MCP URL.
- ChatGPT uses its Plugins route and native schema-refresh flow.

`src/renderer/plugins.ts`, `src/renderer/main.ts`, `src/main/plugins-manager.ts`,
`src/main/bridge.ts` and `extension/background.js` contain those provider-native paths. A future
provider must declare whether it supports MCP URL setup, native plugin refresh, both, or neither.
The extension version/protocol must be checked after every app update; provider changes cannot be
used to bypass a stale companion.

### Models, goals and helpers

Model discovery and selection are native DOM behavior and must be adapter-owned. Several historical
names still use ChatGPT terminology: `goal.backend`, `loopBackend`, `planBackend`, helper-chat code,
ChatGPT project links and model catalogue messages. These are functional backends, not the active
browser provider. Do not infer one from the other.

`src/shared/user-prompt.ts` exports a default message budget from Gemini. Callers that know a chat's
provider should use `chatProviderCapabilities(provider).maxMessageChars`; a third provider may have
a smaller transport budget.

### Skills, mentions and provider-authored context

`resources/skills/gemini-code/SKILL.md`, `mcp.useGeminiWebSkill`, native Gemini Skill selection and
`@OneCode Core`/connector menu behavior are provider-specific. A new provider needs a declared
instruction mechanism: native Skill, connector mention, system instructions, or no injection.
Never assume that installing the MCP URL also installs a Skill or teaches the provider when to use
the tools.

### Copy, localization and diagnostics

Many inherited strings and locale keys still say Gemini or ChatGPT. Provider-native errors should
use the matching name; common app errors should say “provider” or the resolved provider label.
Audit `src/renderer/index.html`, `src/renderer/*.ts`, `extension/_locales/*/messages.json`, tray
copy, setup docs, diagnostics and notifications for every provider addition.

Older comments and identifiers that describe actual Gemini-only proof may keep the name. Rename only
when the implementation becomes neutral; cosmetic renames must not blur security boundaries.

### Remote and mobile surfaces

The provider's own mobile client is not a substitute for OneCode remote control: tool approval and
browser-session custody can differ from desktop. The planned tailnet-only remote web app must call
OneCode's provider-neutral control/session APIs and display the actual provider for each chat. It
must not scrape Gemini or ChatGPT mobile pages or inherit a browser provider from the viewing device.

## Required test matrix for every provider

1. Sign in using a supported full browser and connect the provider's MCP/plugin route.
2. Create a new chat, run read and write tools, answer an approval, stop a turn and resume it.
3. Compact to a Markdown handoff, save it, open the successor and prove exact receipt ownership.
4. Switch to every other enabled provider without restarting OneCode or reloading unrelated chats.
5. Send new work on the selected provider and follow up in one existing chat from each provider.
6. Enable trust validation for only provider A. Prove an untrusted A chat is refused, a trusted A
   chat works, and provider B keeps its independently saved policy. Repeat with A/B reversed.
7. Restart OneCode and the PC. Prove provider choice, trust policy, chats, MCP URLs and extension
   compatibility persist.
8. Update the app. Prove the extension updates or gives a clear reload/update action before work is
   accepted under a mismatched bridge protocol.
9. Exercise provider-specific models, attachments, projects/plugins, generated images and account
   routes only where the capability registry enables them.
10. Run focused adapter, routing, trust, continuation and packaged-runtime tests, then repeat the
    signed-in switch flow in the packaged build.

## Audit searches

Run these before declaring a new provider complete:

```powershell
rg -n "provider !== 'gemini'|provider === 'chatgpt'|provider === 'gemini'" src extension
rg -n "gemini\.google\.com|chatgpt\.com|chat\.openai\.com" src extension resources
rg -n "Gemini|gemini|ChatGPT|chatgpt" src/main src/shared src/renderer extension
rg -n "strictChatAllowlist|trustedChat|blockedChat" src test
rg -n "nativeProjects|nativePluginRefresh|generatedImageExport|receipt:|handoff:" src
```

Review every match. A provider-specific adapter match can be correct; an unguarded shared-path match
is a release blocker.
