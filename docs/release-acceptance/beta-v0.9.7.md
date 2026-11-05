# OneCode 0.9.7 Beta — validation record

The reported Continue was durably claimed after about 1.2 seconds and acknowledged after about 37.3 seconds. The old records do not split the remaining interval between preparation and remote header wait. The later REQUEST_TOO_LARGE code is OneCode's two-MiB pre-HTTP guard, not proof of an upstream context rejection. A read-only inspection found the history itself near that threshold before adding the system/tool envelope; the stored bytes were unchanged by diagnosis.

The candidate raises local transport/history bounds without deleting history, shares validated catalog definitions between UI/runtime, and exposes pending preparation/provider-wait status and safe timings. Canonical delivery receipts, task identities, terminal publications and permission checks retain their existing owners.

Acceptance covers a synthetic saved chat above two MiB retaining its original checkpoint with one completion and no tool replay; local over-limit rejection before HTTP; cache reuse/expiry/refresh; stale-key response rejection; cancellation isolation; pre-header status without a fabricated Sent receipt; and actual renderer phase changes. All fixtures use isolated temporary profiles and synthetic credentials. No production application, profile, dashboard project or task process is changed.

Final local checks and publication evidence follow below. Stable remains on hold pending user testing; automatic API compaction remains unavailable.

## Local verification

- 997 broader tests passed across fifteen native-input, parallel/session-input, Remote-action, Companion, permission/identity/inbox, prompt/error and timeline suites.
- 36 focused actual-renderer delivery cases passed, including the three API work/recovery/pending-phase cases. After the caption-layout adjustment, the pending-phase case passed again and an isolated offscreen Electron capture was inspected. It displays provider wait on one line and no Sent claim before receipt.
- Public verify passed after the final application changes: privacy/history, license/native-source references, TypeScript and production Desktop/Remote bundles. Ordinary Vite chunk-size warnings remain.
- The existing Windows capacity stress fixture initially mistook a reused PID belonging to another application for its original child. The ignored fixture now compares process start identities; it still launches 64 real children, refuses the 65th and checks their exit plus retained results. The complete 21-case spool suite passed with that correction. No unrelated process was stopped.
- All user-profile inspection was read-only, reported aggregate byte/timing metadata only and verified the inspected file remained unchanged. Synthetic large-history tests retain the original model checkpoint and execute no tool replay. No real provider key was copied into a fixture.

- The final combined affected-owner run passed all 127 tests across ten API/terminal/code-mode/ownership suites. Together with the 997 broader cases and 36 renderer cases, 1,160 distinct tests passed. The final production verify passed with no application changes afterward.

## Cloud candidate and publication status

Application source is frozen at `bc5b0b9820edc326a806728be89e5b3d27266796`, tag `beta-v0.9.7`. Both the Beta source branch and mutable Stable preparation branch were pushed to that source. [GitHub run 42036122243](https://github.com/hassanradwannn/OneCode/actions/runs/42036122243) completed with conclusion `success`. Its workflow revision is the existing `release` branch; the separately validated application `source_ref` is the frozen Beta SHA above.

Published [Beta 0.9.7](https://github.com/hassanradwannn/OneCode/releases/tag/beta-v0.9.7) at **2026-11-05T14:34:05Z**, with `draft=false`, `prerelease=true` and `latest=false`. Connectivity recovered before publication; the existing draft and build were inspected rather than recreated. The annotated remote tag dereferences to the frozen application SHA above.

- All three cloud jobs succeeded, including both platforms' source/draft validation, public verification, packaged-runtime smoke, checksum validation and curated upload, plus canonical checksum finalization.
- Verified exactly 21 curated assets and all 18 payload SHA-256 values against GitHub asset digests. Freshly downloaded small manifests, checksum sidecars/register and Companion archive matched their published digests. Both platform registers merge exactly. Canonical register SHA-256: `3c78f6a2ca83b92534fcfbb1dd5f8f1e9c29aa272a0bdefe6d635bb0aea81cf6`.
- Windows capsule: 34,866,336 bytes; native fingerprint `e456c5232264bd65be7c3b5fd7b52d2bffa8e22822edb215941e99947ccd729d`. Linux capsule: 34,857,983 bytes; native fingerprint `3c0ae8d9e70e2bb81fd331ef0e5dc2ba9d8e73adc34915f89afdb41d51d304d3`. Both retain their own verified published Beta 0.8.3 compatible complete-base descriptor; existing base evidence was rehashed locally rather than claimed as a new download.
- Companion `0.9.7 Beta`, stamp `71d8cf7da36c`: all 41 archive files match the frozen source after the existing Beta channel transform, including the archive license, byte for byte.
- Post-publication reads confirmed the same source and all 21 assets. The unauthenticated release feed exposes this prerelease; GitHub's latest Stable remains `v0.8.9` and the `release` branch remains unchanged.

Installed Windows/Linux, signed-in provider, updater and live long-task acceptance remain pending. Stable is neither frozen nor published.
