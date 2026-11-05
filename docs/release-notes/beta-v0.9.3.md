# OneCode 0.9.3 Beta — local API workers and live permissions

This experimental Windows/Linux prerelease includes the unpublished 0.9.2 candidate and the repairs below. Stable 0.8.9 remains unchanged.

- API providers now use a shared local harness with an explicit transport adapter contract. OpenRouter is the first adapter.
- OpenRouter can spawn, report and reuse OneCode workers through the existing broker, session store and durable input outbox, without a browser or native connector credential. Worker workspaces retain their normal approval/isolation checks.
- API requests expose Core code mode and permitted desktop tools. Installed plugin discovery/calls and managed skill import/read use the same local owners as browser providers.
- Folder and capability changes take effect on an open API turn. Effective capabilities apply Read-only and platform limits; nested calls recheck task ownership and cancellation.
- Trusted user messages can grant explicit capabilities before the next input is prepared. Examples: `I grant you permission to run gh commands`, `I allow you to read files and edit files`, `You have full access`, and `Enable workers`. Named commands use the existing command-policy owner. Full access enables capability settings and removes the command allowlist; approved folders remain a separate scope.
- Browser authorization rechecks transient attachment uncertainty both at ingress and handler admission. An exact task credential survives leading blank lines/BOM. Refusals identify task-identity versus storage problems rather than implying a missing command. Compaction supplies a new exact task credential; it does not grant command permissions.
- API worker model IDs survive restart. Interrupted API turns remain visible and uncertain requests/tools are never automatically replayed.

## Test scope and limits

335 local owner regressions and public verification passed; details are recorded in the acceptance document; GitHub validates and packages both platforms. Signed-in native browser acceptance, real OpenRouter model variability, installed Windows/Linux testing and physical Remote testing remain pending user acceptance. API attachments, Goal stages and automatic history compaction remain unavailable. Native desktop capabilities still depend on platform support. Private keys, profiles, logs and local test fixtures are excluded from release assets.
