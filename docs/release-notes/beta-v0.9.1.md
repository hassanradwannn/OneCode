# OneCode 0.9.1 Beta — OpenRouter API-only setup

This prerelease corrects the OpenRouter configuration path in Beta 0.9.0. It is intended for internal Windows and Linux testing, not Stable promotion.

## Changes

- Selecting **OpenRouter** in Setup displays a protected API-key form, not instructions to install a browser extension or sign in through a browser. You can securely save, replace or remove the key. Other web providers keep their existing browser setup.
- An OpenRouter API-key change invalidates previously cached model discovery, including in-flight results from an older key. Model discovery uses the newly saved credential.
- **openrouter/free** can be used as the model route when no exact model is chosen. Actual upstream model capabilities and context limits vary; the local free-route context budget is an estimate, not a provider guarantee.
- OpenRouter streaming requests support available reasoning-effort controls and preserve reasoning_details metadata for subsequent API requests without rendering it as public answer text. API model requests and tool execution remain tied to OneCode session and permission owners.
- The Beta 0.9.0 ChatGPT long-turn continuation/late-ACK authorization repair is retained without relaxing task authentication.

## Known limits

This remains an experimental implementation. OpenRouter automatic history compaction and signed-in native model/tool acceptance are not complete. Free routing may select models with different tool and reasoning capabilities. When an API request or local tool has an uncertain outcome, OneCode must not replay it automatically. The API key must never enter release assets, logs or exported source.

Stable 0.8.9 remains unchanged. The complete Windows/Linux Beta packages and compatible capsules are built and validated independently from the frozen 0.9.1 source tag.
