# OneCode 0.9.6 Beta — validation record

Beta 0.9.5 user acceptance exposed a 16K response ceiling despite a larger advertised model ceiling, length boundaries ending the task, and completed terminal output remaining unread. Source diagnosis found that current local API calls were excluded from the shared acknowledgement gate and their outer publication receipt was never completed. API clipping also differed from the native terminal rendering budget. The saved completed results had zero acknowledged offsets; these were distinct from a still-running test process.

The candidate repairs those existing owners. A validated API response completes only included, non-clipped result publications. A later exact owner call advances the shared durable output cursor. Failed or stopped delivery permits re-offer; restored initial prefixes are not skipped. No command is replayed or production spool discarded to clear a result gate.

Focused acceptance covers restored unread results, Unicode paging, failed delivery and later acknowledgement, cross-session isolation, an owned hung pipe test interrupted without a new exec, verbose terminal tails, model-aware budgets and continuation with incomplete tool proposals left unexecuted. Broad regression, final source verification and publication evidence follow below when complete.

All reproduction uses isolated temporary profiles, synthetic credentials and owned child processes. No production app, profile, task process or generated dashboard project is replaced, restarted or stopped. The local fixtures remain ignored under repository policy. Stable stays on hold for user testing.

## Local verification

- All 119 tests passed in ten affected terminal/API suites: API sessions/transport/budgets/recovery, exact stop/worker ownership, real MCP code-mode transport, durable spool/cursors, output streaming and mutex/capacity behavior.
- All 997 tests passed in fifteen broader suites: native input/openings, parallel/session input, Remote actions, Desktop input maintenance, Companion, provider terminal boundaries, identity/policy/inbox, prompts, explicit grants, errors and timeline rounds. These are distinct from the 119 terminal/API cases.
- Public verify passed on the final application source: privacy/history, notices/native-source references, TypeScript and production Desktop/Remote bundles. Ordinary existing Vite chunk-size warnings remain.
- The five-result reproduction starts from restored records whose initial offer offsets cover the whole retained output but acknowledged offsets are zero. It checks every Unicode code point reaches the model-facing pages, the old commands never execute, a fresh command executes once and a foreign session's result remains isolated.
- Network failure before model delivery leaves the output unacknowledged; a later owner call can acknowledge the successfully delivered page. A 30K-character terminal tail reaches the model intact. Exact owned Ctrl-C succeeds without a new exec; the foreign session cannot interrupt it.
- Output-limit tests expand a 65,536-token request to 131,072 within the fixture model ceiling, preserve safe partial public text, reject partial function proposals and stop repeated reasoning-only exhaustion with an explicit retained-work error.

## Publication receipt

- Published [Beta 0.9.6](https://github.com/hassanradwannn/OneCode/releases/tag/beta-v0.9.6), November 5, 2026 at 12:20:06 UTC. Public unauthenticated update discovery selects this prerelease with 21 assets; draft=false and prerelease=true.
- Frozen application source/tag: `855c69f034cb7003bfa988eeff3374fa70e30568`, `beta-v0.9.6`. Later documentation commits do not change its payload. Published Beta 0.9.5 remains at its original source.
- [GitHub run 42023138146](https://github.com/hassanradwannn/OneCode/actions/runs/42023138146) succeeded for Windows x64, Linux x64 and canonical checksum finalization. Both platforms passed exact-source/draft validation, public verification, packaged-runtime smoke, payload validation and curated upload.
- All 18 payload digests match GitHub asset digests; both platform checksum registers merge exactly into the canonical register. The 21-asset inventory excludes Native-Sources archives.
- Windows runtime `e456c5232264bd65be7c3b5fd7b52d2bffa8e22822edb215941e99947ccd729d`; verified Beta 0.8.3 compatible capsule: 34,866,676 bytes.
- Linux runtime `3c0ae8d9e70e2bb81fd331ef0e5dc2ba9d8e73adc34915f89afdb41d51d304d3`; verified Beta 0.8.3 compatible capsule: 34,858,365 bytes.
- Companion 0.9.6 Beta stamp `2e10dc0dc426`; all 41 archive files match the exact tagged source after the existing Beta transform, including generated stamp and archive-only license.
- Canonical checksum register SHA-256: `b368a9239d4f797951032919c0b893a328676dff1a3ed773fce636e036008454`.
- Two focused actual-renderer cases also passed for API live tool/command/background work and visible recovery without a misleading stopped-task label. These are fixture results, not native installed or live upstream acceptance.
- Stable's public latest remains v0.8.9 and the `release` branch remains unchanged. [Stable integration PR #1](https://github.com/hassanradwannn/OneCode/pull/1) remains a mutable draft awaiting Beta 0.9.6 acceptance. No Stable source freeze, tag, build, installation or publication was performed.
- No installed app, production profile, generated dashboard project or user process was replaced, restarted or stopped. Live upstream, installed/native and physical Remote acceptance remains pending user testing; API automatic compaction is still unavailable.
