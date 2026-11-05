# OneCode 0.9.5 Beta — validation record

The user's Beta 0.9.4 test exposed stop/resend steering, an opaque API_REQUEST_FAILED card and no automatic recovery. Its saved turn failed about 208 seconds after start; only the generic code was retained, so the original transport/internal exception cannot be retrospectively identified. Manual Continue reused the saved tool outcomes and existing command sessions. No production task, process or profile was changed during diagnosis.

The repairs introduce boundary steering, inference-only bounded retry with Retry-After, HTTP/SSE/transport error categories and live recovery status. Already-dispatched tools settle once; unstarted proposals are marked not executed. Credential, context and storage failures require attention rather than automatic replay. The earlier twenty-step limit is extended; history/context bounds remain explicit.

Validation results and publication evidence are recorded after the candidate's final source is verified. Installed/live-provider/device acceptance remains pending user testing. Stable preparation remains mutable and on hold; no Stable freeze, tag, build or publication is authorized by this record.

## Local validation

- 1008 tests passed across 14 suites before the final catalog-transport guard: API transport/session/recovery, native input startup/openings, capability grants, Desktop input maintenance, parallel/session input, Remote actions, timeline rounds, provider prompts/errors and Companion integration.
- After the final catalog guard, all 167 tests in nine affected-owner suites passed, including catalog recovery without duplicate model requests or questions.
- Two focused actual-renderer cases passed: API live tool/command/background work and visible recovery without a misleading Stopped row. An isolated offscreen Electron capture was inspected; it shows recovery and the background-process dock. These are fixtures, not a live upstream/installed-app result.
- Public verification passed: privacy/history, notices/native-source references, TypeScript and production Desktop/Remote bundles. The corrected final lockfile also passed notices/type/privacy checks; its dependency graph is unchanged.
- Covered inference retries with durable tool-result reuse, pre-header recovery without duplicate questions, incomplete tool proposals never dispatched, exhausted retries, HTTP credentials requiring attention, storage failure without replay, Stop cancelling recovery, pending-tool steering and work beyond the old twenty-step cap.
- The local tests and private evidence remain ignored as required by repository policy. No production application was installed, restarted or stopped.

The first draft build was cancelled before asset upload when a final audit found that model-catalog refresh also needed typed transient recovery. The unpublished draft source was revised; no published application tag or artifact was changed.

## Publication receipt

- Published [Beta 0.9.5](https://github.com/hassanradwannn/OneCode/releases/tag/beta-v0.9.5), November 5, 2026 at 10:12:35 UTC. Public unauthenticated update discovery selects this prerelease with 21 assets; draft=false and prerelease=true.
- Frozen application source/tag: `fb28d49cde6b60505857e5c0ee83f4acd81eee4b`, `beta-v0.9.5`. Later documentation commits do not change the payload. Published Beta 0.9.4 remains pinned to its original source.
- [GitHub run 42007505871](https://github.com/hassanradwannn/OneCode/actions/runs/42007505871) succeeded for Windows x64, Linux x64 and canonical checksum finalization. Both platforms passed exact-source/draft validation, public verification, packaged-runtime smoke, payload validation and curated upload.
- All 18 payload digests match GitHub asset digests. Both platform checksum registers merge exactly into the canonical register. The inventory contains 21 curated assets and no Native-Sources archive.
- Windows runtime `e456c5232264bd65be7c3b5fd7b52d2bffa8e22822edb215941e99947ccd729d`; verified Beta 0.8.3 compatible capsule: 34,861,841 bytes.
- Linux runtime `3c0ae8d9e70e2bb81fd331ef0e5dc2ba9d8e73adc34915f89afdb41d51d304d3`; verified Beta 0.8.3 compatible capsule: 34,853,485 bytes.
- Companion 0.9.5 Beta stamp `a347a6b4cb14`; all 41 archive files match the exact tagged source after the existing Beta transform, including generated stamp and archive-only license.
- Canonical checksum register SHA-256: `a0bb985a0ff14ef724ef4b41f32f2ff4559ca876023734c08de338a980148230`.
- Stable's public latest release remains v0.8.9 and the `release` branch remains unchanged. [Stable integration PR #1](https://github.com/hassanradwannn/OneCode/pull/1) remains a mutable draft pending the user's Beta 0.9.5 tests. No Stable source freeze, tag, build, installation or publication was performed.
- No installed app/profile or production process was replaced, restarted or stopped. Live upstream, installed/native and physical Remote acceptance remains pending user testing; API automatic compaction is still unavailable.
