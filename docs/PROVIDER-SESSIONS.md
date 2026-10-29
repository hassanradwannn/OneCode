# Browser conversations and local sessions

OneCode's session ID and the provider's conversation ID are separate identities. A new local chat exists before the provider has created a conversation. Its queued opening freezes the provider and model intent; an exclusive claim later elects its browser document. A browser tab or inserted draft does not bind the local chat to a native conversation: accepted native delivery and the exact recorded user question must do that.

| Identity | What it owns |
| --- | --- |
| Local session ID | Saved task history, project association and retained results. It can retain source and successor conversation IDs across a handoff. |
| Input ID and exclusive claim | One authored message and its preparation, authorization and receipt. An uncertain Send keeps its original custody. |
| Browser tab/document lease | The exact page allowed to prepare that input. A tab appearing open is not proof it can receive it. |
| Provider conversation ID | The native chat attached through the accepted task receipt. It is never inferred from the selected provider or local session ID. |
| Native question/message and turn | The exact user request, assistant response and generation that a tool call or continuation belongs to. |
| Worker family | The verified parent session, worker slot and allocated workspace. Similar names or simultaneous activity do not join families. |

The provider registry normalizes native URLs. Gemini's native conversation ID is its hexadecimal app path; ChatGPT uses its conversation path ID. Claude's `/chat/<UUID>` URL becomes `claude:<UUID>` in local storage so it cannot collide with another provider's UUID. Each native user and assistant UUID is scoped to that conversation. A changed title, selected tab or new-chat provider preference cannot transfer its identity.

Fresh Claude openings create an independently marked `/new` page. Recovery may retain the page already elected for that exact input; it does not adopt an unrelated idle home or an existing chat. The conversation UUID is learned after native delivery, not invented from the opening page or local session ID.

The added adapter prepares the exact authored task and sends it once directly. It does not send a separate readiness greeting or wait for a `READY` exchange before the task. Its accepted question and canonical history establish the conversation binding; an uncertain dispatch retains its original custody rather than earning another Send.

Model-catalog helpers are separate observations. Ordinary refresh reads available current/legacy models without cycling selections. A deliberate model choice may inspect only that model's native reasoning control in its own empty helper. Levels, binary switches and absent controls stay distinct; an unread control does not create a setting. Neither that helper's URL nor a model menu result can bind a user task or replace its native conversation UUID.

## Parallel work

Independent chats have independent input claims, native documents, turns and task credentials. Workers additionally belong to their exact parent family and allocated workspace. A provider selector change, browser focus, similar prompt or completion in another chat supplies no ownership. Queued work can recover its existing worker after restart without creating a replacement for an uncertain task.

Claude's Core endpoint uses a separate installation-bound capability ledger. Every call must join its original app-authored task to the exact native user question, canonical history and active turn. This remains required with unattributed calls enabled. The credential is local task authority, not a provider-authenticated request ID, and never belongs in release notes, screenshots or a different chat.

Connector enablement is separate from those identities. For an account-enabled connector, enable the connection once in native setup. Normal sends do not reopen its menu, toggle it again or require a per-message @ mention. That removes an unnecessary UI preparation gate; it does not permit a tool call with a missing or foreign task credential. If the endpoint or provider connection is unavailable, the actual failure remains visible.

## Compact & Resume

Compaction first identifies the exact source chat and a verified completed public answer. It preserves a handoff with provenance and the original local results. The successor opens a new native conversation and receives fresh task authority only after its own exact Send receipt. The same local task family retains the prior source and worker relationships; moving the prime does not merge unrelated native conversations or transfer old credentials.

Interim prose, hidden reasoning, a missing tool card or a browser Stop icon cannot certify a completed handoff. A failed pre-Send preparation, a delivered question and an uncertain submitted action are distinct states. Recovery never automatically replays an uncertain Send or tool call.

See [architecture](ARCHITECTURE.md) for the input, recorder, continuation, broker and capability owners and [0.8.0 verification](release-acceptance/v0.8.0.md) for the exercised source/native lanes. A source fixture is not proof that an installed provider task completed.
