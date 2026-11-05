# OneCode 0.9.10 Beta

API chats can compact their working context and continue the same task. With automatic compaction enabled, OneCode prepares a handoff near 72% of the selected model's estimated window, and also attempts bounded recovery after a typed upstream context-limit rejection. This runs between model/tool steps and preserves running processes, workers, browser handles and the existing task identity.

OneCode verifies a local archive before replacing working context. It keeps the original and latest user messages plus recent complete tool exchanges; older details are summarized through bounded, tool-free requests to the selected API model. Completed summary parts are cached for recovery. Original conversation/tool records remain available through local history. Opaque reasoning metadata is archived rather than turned into a public summary. Unacknowledged terminal pages retain their exact delivery requirements and cannot be acknowledged merely because a summary was received.

For an already-failed chat, open its context meter and choose **Compact context**, then send **Continue**. A manual compaction can be cancelled without submitting another task message. During a running task, the request waits for a safe boundary. The automatic-compaction switch is respected; manual recovery remains available when it is off. The context meter shows the reduced API working context separately from retained transcript size.

Handoffs use API requests and the selected model's normal pricing. Original/latest requests or required fresh results that cannot fit safely still require a larger-context model. Failed or truncated summaries leave working history unchanged; tools and uncertain actions are never replayed. API attachments and Goal stages remain unavailable. Stable 0.8.9 stays unfrozen and unpublished pending user acceptance.

OpenRouter's optional [context compression](https://openrouter.ai/docs/guides/features/message-transforms) removes or truncates middle messages. This release disables that implicit provider transform and uses the local checkpoint path so task and output-receipt custody remain explicit.
