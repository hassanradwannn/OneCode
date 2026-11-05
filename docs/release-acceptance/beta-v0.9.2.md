# OneCode 0.9.2 Beta — validation record

This candidate includes OpenRouter browserless readiness, exact API tool-call attribution, selected-model context estimates, API-specific truncation messages, first-turn tool-use guidance, and bounded exact task-attachment recovery.

## Pre-release test scope

- Before the latest authorization changes, shared targeted regression tests passed 188/188 across 10 suites and full npm run verify returned exit code 0. These do not by themselves validate the later changes.
- After the authorization repair, the ChatGPT and Claude capability fixtures passed 94/94 tests, including a same-request ambiguous-attachment recovery. The final versioned candidate passed 212/212 affected-owner tests across 10 suites, including first-turn prompts, OpenRouter local tool sessions, context meter, chronology and Remote transcript.
- Full npm run verify passed with exit code 0: public-history/privacy and third-party notices, TypeScript, Desktop and Remote production builds. GitHub Windows/Linux packaging receipts are checked separately before publication. Automated tests are not signed-in native acceptance.

## Release rules and gaps

Build complete Windows/Linux Beta applications and compatible capsules from one frozen source SHA via GitHub beta-release, with independently verified published Beta 0.8.3 complete bases. Verify payload digests and runtime fingerprints and exclude Native-Sources archives.

Pending: signed-in first-message connector exposure, OpenRouter live upstream-model variability, automatic API history compaction, installed Windows/Linux acceptance and physical Remote testing. The Stable channel and installed app profiles are not modified by this source release.
