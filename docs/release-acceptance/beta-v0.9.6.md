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
