# OneCode 0.9.9 Beta — validation record

OpenRouter setup hid its enclosing Browser step, including the provider picker and API-key form. Its navigation still considered hidden browser/tunnel checks when determining the active step, while progress counted only visible steps. This explains an unreachable picker and inconsistent complete/current state without implying lost settings.

The repair retains the provider step, omits unused transport steps from the API route, derives current/completed state from that visible route and uses secure saved OpenRouter-key readiness. API Next is visible, Folder Back reaches provider selection, and changing provider keeps that form open through the existing settings queue. Ready's API check identifies the key. A separate Back to chats action works independently of readiness and performs no settings write.

Tests mount the actual renderer with saved/missing keys, click the rail/Next/Back/exit controls, switch OpenRouter to Claude and back through the ordinary save owner, and retain existing native provider behavior. Fixtures are isolated; production profiles, credentials and conversations are not changed. Final verification and cloud publication receipts follow below. Stable remains unfrozen and unpublished.

## Local verification

- Eight focused actual-renderer cases passed after the final behavior change, including API key present/absent, provider switches, visible route navigation, exit and native sign-in behavior. Ten browser-setup cases, seven setup-recovery cases and eight provider-settings/copy cases also passed. An obsolete three-provider fixture was updated to include the registered OpenRouter option; it still checks exact selection and one durable save.
- Final public verification passed: source privacy/history, notices/native references, TypeScript and production Desktop/Remote builds. Existing chunk-size warnings remain.
- An isolated hidden Electron capture of the actual renderer state and source CSS confirms visible provider picker, key field, Next and exit, selected OpenRouter value, and absence of the browser-only Back control. Interaction behavior is covered by the mounted-renderer tests. This is not acceptance of a changed installed profile.
- The broader renderer run remains a separate gate before publication; its final result is recorded below. No production settings/key writes, installation, native provider Send or app restart occurred.

The broader run completed all 156 renderer cases and the 25 setup/provider/recovery cases. Two obsolete fixture expectations failed: a pre-API provider list and an assertion counting the existing hidden network-repair button as visible UI. Each corrected case passed in a focused rerun. A final native-browser visibility check passed after preserving the browser owner's legacy embedded-choice Back state; the five affected renderer cases and final public verification passed afterward. Across the runs, **182 distinct cases passed**, with overlapping reruns counted once. The initial unpublished cloud candidate `42075391360` was cancelled before final source replacement; it is not publication evidence.

## Published release

Published [Beta 0.9.9](https://github.com/hassanradwannn/OneCode/releases/tag/beta-v0.9.9) at **2026-11-05T17:42:52Z**, with `draft=false`, `prerelease=true` and `latest=false`. Application source is frozen at `994e21ec28a0fe0ece1dc894d4a572586b63c654`; the annotated remote tag dereferences to that source. Later documentation commits leave the application tag pinned.

[GitHub run 42076056055](https://github.com/hassanradwannn/OneCode/actions/runs/42076056055) succeeded. Both platforms passed exact-source/draft validation, public verification, packaging, packaged-runtime smoke, curated checksum validation and upload. The canonical checksum finalizer also passed. Workflow tools came from the unchanged Stable `release` revision; the application came from the separate exact Beta source SHA.

- Verified all 21 curated assets and 18 payload SHA-256 values against GitHub digests. Fresh downloads of the small manifests, platform sidecars/register and Companion matched those values. The two platform registers merge exactly. Canonical checksum-register SHA-256: `596272c5d521a3202cbbba27672cf11775acad968005f7eeab3524348735e7b3`.
- Windows capsule: 34,868,206 bytes, native fingerprint `e456c5232264bd65be7c3b5fd7b52d2bffa8e22822edb215941e99947ccd729d`. Linux capsule: 34,859,852 bytes, native fingerprint `3c0ae8d9e70e2bb81fd331ef0e5dc2ba9d8e73adc34915f89afdb41d51d304d3`. Both retain their matching published Beta 0.8.3 compatible complete-base descriptor, freshly downloaded and checksum-verified.
- Companion `0.9.9 Beta`, stamp `737b82a84532`: all 41 archive files match the frozen source after the existing Beta channel transform, including the license, byte for byte.
- Post-publication reads verified this source, all 21 assets and public prerelease discovery. Latest Stable remains `v0.8.9`; the `release` branch remains `ca9bedf630084d976624fcd0c4cc6f3a1284f7d8`.

Installed/updater and live-provider acceptance remain pending. No production profile, credential, permission, conversation or running task was changed. Stable remains unfrozen and unpublished pending user acceptance.
