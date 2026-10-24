# OneCode API (Experimental)

OneCode 0.6.3 can expose the running desktop app as an **Experimental** local OpenAI-compatible API. The API is a façade over OneCode, not a second agent runtime: requests enter the same durable chat/input path used by the desktop, the selected browser provider runs the turn, and that turn keeps OneCode's normal Core tools, permissions, skills, installed MCP plugins, workers and recording rules.

The feature is **off by default**. While it is off, OneCode does not bind the API port or run API-specific background work.

## Enable and connect

Open **Settings → General → For developers**, turn on **OneCode API (Experimental)**, and keep or change the loopback port. The default base URL is:

```text
http://127.0.0.1:32123/v1
```

Choose **Copy API key** and paste that value into the IDE or client as its OpenAI API key. The key is unique to this OneCode profile/device, stored in the operating system's encrypted credential store, and survives normal restarts and application updates. It is never displayed in the renderer. **Rotate key** immediately revokes the previous key for new requests.

Use the base URL and bearer key anywhere a client accepts a custom OpenAI-compatible endpoint. For example, an IDE should use `http://127.0.0.1:32123/v1` as its OpenAI base URL and the copied OneCode key as the API key.

The listener binds only to `127.0.0.1`. Requests must use its loopback Host, must carry `Authorization: Bearer <key>`, and browser-origin requests are refused. The API is intended for programs on the same computer; it is not a LAN or Internet server.

## OpenAI-compatible endpoints

The experimental API supports these client-facing endpoints:

- `GET /v1/models` — advertises `onecode`, `onecode-chatgpt`, and `onecode-gemini`.
- `POST /v1/chat/completions` — accepts text chat messages and returns an OpenAI-style chat completion. `stream: true` returns SSE after the native OneCode answer is complete.
- `POST /v1/responses` — accepts text input or message items and returns an OpenAI Responses-style result. `stream: true` emits a completed-response SSE event.

`onecode` uses the API's currently selected provider for a new chat. `onecode-chatgpt` and `onecode-gemini` explicitly select that provider for an unbound new chat. Once a OneCode chat is bound to a provider, that chat keeps its provider; switch provider by selecting it and opening a new chat rather than retargeting an existing conversation.

The experimental API is text-in/text-out at the OpenAI HTTP boundary. Files, images and provider-native request features are not claimed as OpenAI API compatibility yet. The OneCode agent inside the selected browser chat can still use all OneCode capabilities that the user has enabled.

## IDE integration

0.6.3 keeps IDE-originated chats separate from the device-level control chat. When a client supplies a stable thread or conversation identifier, OneCode uses it. For clients such as JetBrains BYOK that may not expose one, OneCode uses the IDE project plus first user turn as a bounded fallback and starts a fresh mapping for a new first-turn chat after the previous mapping has completed. A different IDE project therefore cannot silently continue the previous project's OneCode chat.

JetBrains AI Assistant also sends internal model requests for code-search subqueries and chat titles. OneCode handles those known housekeeping requests locally; they do not create provider chats, consume the real OneCode completion slot, or enter durable OneCode history.

The durable OneCode session is the history owner. The API keeps the IDE's system/developer instructions and current user/file attachment context, but it does not copy the client's earlier assistant/tool transcript back into every turn. This avoids quadratic context growth while preserving the editor/project context needed for the current request.

For direct edits, IDE metadata never grants filesystem permission. If the IDE project matches an already-approved OneCode project/root, the API binds that session to the normal OneCode project owner and the agent can use direct filesystem read/patch/exec tools; CLion or PyCharm then observe the file changes normally. If the project is not approved, approve/share that folder in OneCode once. Until then the agent is told not to drive the IDE by mouse and to return the IDE's native edit/snippet format instead.

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

The API keeps one device/profile-level control chat/default provider across restarts, plus a bounded set of recent IDE thread mappings. `/new` and `/session` still control the explicit API chat; IDE-originated requests use their own mapped OneCode sessions so a new project/chat does not inherit unrelated provider history.

One real OneCode API completion is admitted at a time in the current experimental implementation. Known IDE housekeeping requests are answered locally and do not occupy that slot, preventing JetBrains' parallel retrieval/title calls from delaying the real coding turn. Each IDE thread still has its own durable OneCode session.

If the HTTP client disconnects, OneCode stops waiting for that HTTP response. It does **not** assume the provider turn was cancelled or replay the request: the already-admitted OneCode input retains custody and may still finish in its chat.

## Persistence and updates

The API enable switch, port, current API chat/default provider, and encrypted bearer key survive ordinary restarts. Application hotfix/capsule updates preserve the same profile, so the API identity survives compatible updates as well.

Stable 0.6.3 is designed to ship as an application capsule when the published stable base has the same immutable runtime fingerprint. Packaging verifies that fingerprint before a capsule is accepted; a mismatch fails the release instead of weakening update compatibility.
