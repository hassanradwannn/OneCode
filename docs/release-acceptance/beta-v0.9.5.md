# OneCode 0.9.5 Beta — validation record

The user's Beta 0.9.4 test exposed stop/resend steering, an opaque API_REQUEST_FAILED card and no automatic recovery. Its saved turn failed about 208 seconds after start; only the generic code was retained, so the original transport/internal exception cannot be retrospectively identified. Manual Continue reused the saved tool outcomes and existing command sessions. No production task, process or profile was changed during diagnosis.

The repairs introduce boundary steering, inference-only bounded retry with Retry-After, HTTP/SSE/transport error categories and live recovery status. Already-dispatched tools settle once; unstarted proposals are marked not executed. Credential, context and storage failures require attention rather than automatic replay. The earlier twenty-step limit is extended; history/context bounds remain explicit.

Validation results and publication evidence are recorded after the candidate's final source is verified. Installed/live-provider/device acceptance remains pending user testing. Stable preparation remains mutable and on hold; no Stable freeze, tag, build or publication is authorized by this record.

## Local validation

- 1008 tests passed across 14 suites after final app changes: API transport/session/recovery, native input startup/openings, capability grants, Desktop input maintenance, parallel/session input, Remote actions, timeline rounds, provider prompts/errors and Companion integration.
- Two focused actual-renderer cases passed: API live tool/command/background work and visible recovery without a misleading Stopped row. An isolated offscreen Electron capture was inspected; it shows recovery and the background-process dock. These are fixtures, not a live upstream/installed-app result.
- Public verification passed: privacy/history, notices/native-source references, TypeScript and production Desktop/Remote bundles. The corrected final lockfile also passed notices/type/privacy checks; its dependency graph is unchanged.
- Covered inference retries with durable tool-result reuse, pre-header recovery without duplicate questions, incomplete tool proposals never dispatched, exhausted retries, HTTP credentials requiring attention, storage failure without replay, Stop cancelling recovery, pending-tool steering and work beyond the old twenty-step cap.
- The local tests and private evidence remain ignored as required by repository policy. No production application was installed, restarted or stopped.
