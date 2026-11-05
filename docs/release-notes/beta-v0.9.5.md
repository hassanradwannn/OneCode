# OneCode 0.9.5 Beta — API task continuity and recovery

- Retry transient model-discovery, network, timeout, rate-limit, provider-unavailable and incomplete-stream failures from the current saved model-step checkpoint. Up to five retries use increasing delays and respect Retry-After up to five minutes. Recovery status and successful reconnection appear in the timeline; Stop cancels a retry wait.
- Preserve completed tool results, running commands, process IDs and worker families. Only inference is retried. Tool dispatch, local history/proof writes and uncertain tool outcomes are never automatically repeated. A retried inference request may incur additional provider tokens.
- Apply Steer at the next model/tool boundary without aborting the running response or an already-dispatched tool. Skip proposed tools that have not started and record that no action ran. Continue the existing objective with the user's update and saved results. Explicit After this turn still waits for task completion.
- Explain HTTP status, connection loss, timeout, credentials, credits, storage and exhausted recovery. Detect errors inside HTTP-success event streams. Do not display raw provider bodies, private URLs, credentials or local exception paths.
- Increase task bounds from 20 model steps/60 tool calls to 1000 steps/3000 calls. Model context and local history limits still apply and are reported explicitly.

Native mid-turn inference steering requires a supported provider/model/transport. [OpenAI documents GPT-6 steering over Responses WebSockets](https://developers.openai.com/api/docs/guides/steering). [OpenRouter currently documents its Responses API as stateless](https://openrouter.ai/docs/api_reference/responses/overview); this Beta uses boundary steering over Chat Completions, not an unsupported WebSocket claim.

Windows/Linux full assets and compatible capsules retain the verified Beta base contract. Stable remains 0.8.9, unfrozen and unpublished for this candidate. Live upstream, installed Windows/Linux and physical Remote acceptance remain separate from automated fixtures. API automatic compaction, attachments and Goal stages remain unavailable.
