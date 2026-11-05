# OneCode 0.9.2 Beta — browserless API tools and task recovery

This experimental Windows/Linux prerelease builds on Beta 0.9.1. Stable 0.8.9 remains unchanged.

## Improvements

- OpenRouter no longer displays browser-disconnection or extension-waiting warnings for an API-only chat. The Companion bridge remains available for existing ChatGPT, Gemini and Claude chats.
- API tools and nested results are recorded under the exact OneCode API turn using local attribution, not a fabricated native browser request ID.
- The selected model ID is stated in the API system instruction. The dynamic openrouter/free route is explicitly identified as variable. Completion-token budgets now account for longer reasoning and tool turns within advertised model limits.
- The context meter uses the selected OpenRouter catalog window when known. Dynamic model limits remain estimates; API automatic history compaction is not implemented and is no longer presented as enabled.
- API truncation and request errors show API-specific guidance rather than asking users to open a provider browser.
- The first app-authored browser-provider message advises models to check actually exposed tools. OpenRouter sends real local tool declarations with its first API request.
- Valid ChatGPT/Claude task credentials briefly recheck a temporarily ambiguous session attachment after refresh. Missing, revoked, blocked, superseded and wrong-provider task credentials still fail closed.

## Known limits

Setup folder and command permissions alone do not prove task or turn identity. The bounded refresh check does not create credentials, weaken grants, or replay uncertain actions. Signed-in native first-message acceptance across browser providers remains pending. OpenRouter model routing may change upstream tool, reasoning and context support. Automatic API history compaction and installed Windows/Linux and Remote acceptance remain pending. Private keys, profiles, local test fixtures and graph evidence are excluded from release assets.
