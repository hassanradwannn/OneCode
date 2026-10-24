# OneCode API (Beta)

OneCode 0.6.2 Beta can expose the running desktop app as a local OpenAI-compatible API. The API is a façade over OneCode, not a second agent runtime: requests enter the same durable chat/input path used by the desktop, the selected browser provider runs the turn, and that turn keeps OneCode's normal Core tools, permissions, skills, installed MCP plugins, workers and recording rules.

The feature is **off by default**. While it is off, OneCode does not bind the API port or run API-specific background work.

## Enable and connect

Open **Settings → General → For developers**, turn on **OneCode API (Beta)**, and keep or change the loopback port. The default base URL is:

```text
http://127.0.0.1:32123/v1
```

Choose **Copy API key** and paste that value into the IDE or client as its OpenAI API key. The key is unique to this OneCode profile/device, stored in the operating system's encrypted credential store, and survives normal restarts and application updates. It is never displayed in the renderer. **Rotate key** immediately revokes the previous key for new requests.

Use the base URL and bearer key anywhere a client accepts a custom OpenAI-compatible endpoint. For example, an IDE should use `http://127.0.0.1:32123/v1` as its OpenAI base URL and the copied OneCode key as the API key.

The listener binds only to `127.0.0.1`. Requests must use its loopback Host, must carry `Authorization: Bearer <key>`, and browser-origin requests are refused. The API is intended for programs on the same computer; it is not a LAN or Internet server.

## OpenAI-compatible endpoints

The Beta supports these client-facing endpoints:

- `GET /v1/models` — advertises `onecode`, `onecode-chatgpt`, and `onecode-gemini`.
- `POST /v1/chat/completions` — accepts text chat messages and returns an OpenAI-style chat completion. `stream: true` returns SSE after the native OneCode answer is complete.
- `POST /v1/responses` — accepts text input or message items and returns an OpenAI Responses-style result. `stream: true` emits a completed-response SSE event.

`onecode` uses the API's currently selected provider for a new chat. `onecode-chatgpt` and `onecode-gemini` explicitly select that provider for an unbound new chat. Once a OneCode chat is bound to a provider, that chat keeps its provider; switch provider by selecting it and opening a new chat rather than retargeting an existing conversation.

This Beta is text-in/text-out at the OpenAI HTTP boundary. Files, images and provider-native request features are not claimed as OpenAI API compatibility yet. The OneCode agent inside the selected browser chat can still use all OneCode capabilities that the user has enabled.

## OneCode controls

The API also exposes small local controls for clients that want OneCode chat semantics directly. Each short route has an equivalent `/v1/onecode/...` route.

```text
GET  /provider
POST /provider          {"provider":"chatgpt" | "gemini"}

POST /new               {}
POST /new               {"provider":"chatgpt" | "gemini"}

GET  /session
POST /session           {"session_id":"..."}

GET  /capabilities
GET  /health
```

`/new` creates a durable empty OneCode chat and makes it the API's current chat. The first completion uses the ordinary OneCode opening-input transaction to bind that reserved chat exactly once. `/session` selects an existing normal OneCode chat; worker/helper chats stay under their owning run and cannot be taken over by the API.

`/provider` changes the default provider used by subsequent unbound/new chats. It does not migrate a conversation that already belongs to ChatGPT or Gemini.

## Live capabilities

`GET /v1/onecode/capabilities` is generated on every request from OneCode's current owners. It reports the Core tool catalog, currently enabled desktop/browser methods, live permissions, multi-agent status, installed plugin/tool schemas and the current skill library. Installing/enabling a plugin, adding a skill, or changing permissions therefore changes the advertised capability data without restarting the API listener.

The capability document is descriptive. It does not grant permissions. Actual tool calls still pass through OneCode's existing provider-scoped admission, sandbox, folder grants, read-only mode and per-tool permission owners inside the OneCode agent turn.

## Chat and concurrency behavior

The API keeps one device/profile-level current chat and default provider across restarts. This is intentionally close to using the OneCode desktop: `/new` changes the current API chat, `/session` selects another, and the next completion goes there.

One API completion is admitted at a time in 0.6.2 Beta. This avoids races between independent OpenAI clients and the single current-chat pointer while the behavior is experimental. `/new`, `/provider` and reads remain explicit controls; a later Beta can add client-scoped sessions without changing the underlying OneCode chat/input owner.

If the HTTP client disconnects, OneCode stops waiting for that HTTP response. It does **not** assume the provider turn was cancelled or replay the request: the already-admitted OneCode input retains custody and may still finish in its chat.

## Persistence and updates

The API enable switch, port, current API chat/default provider, and encrypted bearer key survive ordinary restarts. Application hotfix/capsule updates preserve the same profile, so the API identity survives compatible updates as well.

Beta 0.6.2 is designed as an application capsule over the complete Beta 0.5.7 runtime. Packaging verifies the immutable runtime fingerprint before a capsule is accepted; a mismatch fails the release instead of weakening update compatibility.
