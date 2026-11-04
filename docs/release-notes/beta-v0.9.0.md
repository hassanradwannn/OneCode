# OneCode 0.9.0 Beta — experimental OpenRouter API support

This prerelease is intended for internal Windows/Linux testing before any Stable update. It keeps the browser providers and their existing task permissions in place while adding a separate, browserless OpenRouter API path.

## Highlights

- **OpenRouter provider:** Configure an API key in OneCode Settings, refresh the model catalog, and select a supported OpenRouter model. The model list reports context size, provider output limits when available, and whether tools are supported. Requests use the OpenRouter API; no OpenRouter browser is launched.
- **Local sessions and tools:** OpenRouter messages enter the durable OneCode outbox and session history. Model-requested tools are dispatched through OneCode's local registry and current permissions; API responses do not authorize arbitrary commands. Uncertain remote Send/tool outcomes are not silently replayed.
- **Automatic continuation authorization:** When a long ChatGPT turn rotates, an exact native Send receipt can repair the successor question's identity if the page reports the new turn before its user-message ACK. Previous-task credentials remain revoked; ambiguous successors do not inherit them.
- **Complete Beta packages:** Windows x64 installer and Linux x64 AppImage/DEB accompany compatible application capsules built against the last verified complete Beta base.

## Known limitations / acceptance pending

OpenRouter model behavior, costs, and tool support vary by selected upstream model. The initial implementation rejects requests that exceed its estimated context budget; automatic compaction of OpenRouter history is not yet implemented. A request interrupted after remote acceptance can have an uncertain outcome and must be inspected rather than replayed. The signed-in, real-API end-to-end Windows test, native companion refresh/continuation test, and Linux installed acceptance are not yet complete. Do not use this candidate for unattended high-impact actions.

The Stable channel remains on 0.8.9 until Beta testing is accepted. Beta and Stable installations use separate identities and profiles; do not copy credentials or active histories between them.
