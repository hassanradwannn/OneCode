# OneCode 0.9.7 Beta — larger API chats and send visibility

- Raise OneCode's local serialized JSON request bound from 2 to 16 MiB and durable API thread allowance from 6 to 32 MiB. These are local memory/storage bounds, separate from a model's token context. Existing conversations and tool results remain unchanged; no task is restarted or history silently discarded to fit the old guard.
- Distinguish an upstream HTTP 413 request-body rejection from the local transport bound, with clear retained-work guidance.
- Reuse validated model definitions through the existing OpenRouter catalog owner. UI and API execution share a fifteen-minute cache and one in-flight GET. Explicit refresh and changed credentials invalidate it; a cancelled chat does not cancel another chat's shared discovery.
- Show Desktop API request preparation and provider-wait stages while a message is pending. Keep the actual Sent receipt tied to HTTP acceptance. Emit safe diagnostic durations for queueing, catalog lookup, local preparation and header wait, plus request bytes; request text and credentials are never logged by these timings.

This removes avoidable local discovery work and explains provider waits; it does not guarantee a fixed upstream response time. [OpenRouter distinguishes provider queue/prefill latency from streaming](https://openrouter.ai/docs/guides/best-practices/latency-and-performance). API automatic compaction, attachments and Goal stages remain unavailable; model context limits still apply.

Stable remains 0.8.9. Its next release stays unfrozen and unpublished pending user acceptance. Installed/live-provider and physical Remote acceptance remains separate from automated fixtures and package smoke checks.
