# OneCode 0.9.9 Beta — validation record

OpenRouter setup hid its enclosing Browser step, including the provider picker and API-key form. Its navigation still considered hidden browser/tunnel checks when determining the active step, while progress counted only visible steps. This explains an unreachable picker and inconsistent complete/current state without implying lost settings.

The repair retains the provider step, omits unused transport steps from the API route, derives current/completed state from that visible route and uses secure saved OpenRouter-key readiness. API Next is visible, Folder Back reaches provider selection, and changing provider keeps that form open through the existing settings queue. Ready's API check identifies the key. A separate Back to chats action works independently of readiness and performs no settings write.

Tests mount the actual renderer with saved/missing keys, click the rail/Next/Back/exit controls, switch OpenRouter to Claude and back through the ordinary save owner, and retain existing native provider behavior. Fixtures are isolated; production profiles, credentials and conversations are not changed. Final verification and cloud publication receipts follow below. Stable remains unfrozen and unpublished.

## Local verification

- Eight focused actual-renderer cases passed after the final behavior change, including API key present/absent, provider switches, visible route navigation, exit and native sign-in behavior. Ten browser-setup cases, seven setup-recovery cases and eight provider-settings/copy cases also passed. An obsolete three-provider fixture was updated to include the registered OpenRouter option; it still checks exact selection and one durable save.
- Final public verification passed: source privacy/history, notices/native references, TypeScript and production Desktop/Remote builds. Existing chunk-size warnings remain.
- An isolated hidden Electron capture of the actual renderer state and source CSS confirms visible provider picker, key field, Next and exit, selected OpenRouter value, and absence of the browser-only Back control. Interaction behavior is covered by the mounted-renderer tests. This is not acceptance of a changed installed profile.
- The broader renderer run remains a separate gate before publication; its final result is recorded below. No production settings/key writes, installation, native provider Send or app restart occurred.
