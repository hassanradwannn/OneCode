# OneCode

A desktop workspace for AI providers and local tools on Windows and Linux. Work with files, run commands, use MCP plugins and local skills, and keep chats and projects together.

**Stable release: [OneCode 0.8.2](https://github.com/hassanradwannn/OneCode/releases/tag/v0.8.2)** · **[Windows x64 installer](https://github.com/hassanradwannn/OneCode/releases/download/v0.8.2/OneCode-Setup-x64.exe)** · **[Linux x64 AppImage](https://github.com/hassanradwannn/OneCode/releases/download/v0.8.2/OneCode-Linux-x64.AppImage)** · **[Linux x64 DEB](https://github.com/hassanradwannn/OneCode/releases/download/v0.8.2/OneCode-Linux-x64.deb)** · [Windows setup guide](docs/WINDOWS-SETUP.md)

Fresh installs use the complete Windows/Linux artifacts linked above. Compatible existing Stable installations use verified application capsules while retaining their matching native base. Capsule manifests and published base descriptors determine compatibility; a newer app version alone does not require a new full installer.

The current release supports **Windows x64 and Linux x64**, with **ChatGPT web, Gemini web and Claude web** through one Companion extension.

**Already installed?** Open **Settings → General → Check for updates → Install when done**. Compatible Windows, Linux AppImage and positively identified DEB installations can activate a verified application capsule without replacing the immutable native base. Full DEB/native changes remain package-manager-owned. Your profile and saved chats are preserved.

## What's new in 0.8.4

- Progressively import older native public reasoning/activity in long ChatGPT conversations and preserve long native observations beyond the former premature 400 KiB recorder cutoff.
- Recover Compact & Resume after a network/provider disconnect only after the replacement browser document proves the same chat is ready, instead of leaving the extension stranded until manual browser activity.
- Preserve the provider-observed model identity across fresh-chat preparation on ChatGPT, Gemini and Claude while still requiring one exact native choice.
- Keep Steer anchored at the exact correction boundary in long chats instead of jumping to the absolute top or end.
- Preserve provider block code when native markup omits a traditional code wrapper, without swallowing adjacent explanation text into the fence.
- Show plugin installation progress and clear results, retain setup guidance after installation, and provide the matching Blender add-on as a direct download.
- Show the OneCode logo in the Windows notification area while retaining the in-app status dot, and carry the Linux dock-identity repair prepared after 0.8.2.

0.8.4 is an application/Companion hotfix. Compatible Windows installations retain the verified 0.5.9 complete base; compatible Linux installations retain the verified 0.8.2 complete base. Published capsule manifests and runtime receipts remain the authority for whether the internal updater can use the smaller payload. Full DEB/native replacement remains package-manager-owned.

See [0.8.4 release notes](docs/release-notes/v0.8.4.md) and [verification scope](docs/release-acceptance/v0.8.4.md) for frozen-source tests, platform build receipts, bases, checksums and publication evidence.

## Earlier releases

### 0.8.2

- Prevent Linux duplicate launches from changing update rollback state before the primary process owns its single-instance lock.
- Recover validated browser/provider settings only when native downgrade/reset evidence proves the older application changed them.
- Retain exact-route connector evidence across restart and preserve the verified Linux launcher/window identity.

See [0.8.2 release notes](docs/release-notes/v0.8.2.md) and [verification scope](docs/release-acceptance/v0.8.2.md).

### 0.8.1

- Retain the existing question and generation through reconnect and native-tab refresh, without replaying an uncertain Send.
- Require the current native question and answer before a completed Gemini or Claude response can end the task; historical footers cannot close a newer task while its command runs.
- Capture exposed native inline HTML/SVG diagrams. Cards grow to the diagram's dimensions, and expanded previews fit the whole chart within the screen.
- Preserve formatted code, indentation and blank lines inside lists and quotations across the native adapter paths.
- Show update bytes, known totals, verification and preparation before ready-to-install. Compatible application capsules retain the verified 0.5.9 complete-base chain.
- Show a Tailscale network wait separately from a failed Funnel permission check while preserving saved route custody.

See [0.8.1 release notes](docs/release-notes/v0.8.1.md) and [verification scope](docs/release-acceptance/v0.8.1.md). Windows and Linux builds passed verification, and Linux download progress was confirmed by the maintainer. Automated checks and native acceptance are recorded separately.

The preceding [0.7.4 release](docs/release-notes/v0.7.4.md) supports both ChatGPT picker layouts, opens new chats in Chat by default, retains explicit Work choices, adds Gemini Thinking levels and reduces avoidable browser preparation delays. These repairs are included.


### 0.8.0

Added Claude web alongside ChatGPT and Gemini, account-observed models and effort controls, guided custom MCP and optional native skill setup, observed usage limits, and isolated React/TSX previews. See [0.8.0 release notes](docs/release-notes/v0.8.0.md).

### 0.7.0

This release brings together the reliability repairs developed since Stable 0.6.17:

- **Steer while tools run.** Follow-ups retain the original command, its output and authorization for calls already running.
- **Replies stay with the right question.** Rapid ChatGPT follow-ups preserve reply ownership when the native page redraws or groups several questions together.
- **Chats can progress independently.** A slow transcript upload or a stuck tab no longer holds up message delivery in unrelated chats.
- **Gemini preparation and recovery.** Model selection follows changing native controls, stalled initial preparation has bounded recovery, and approval matching uses the configured connector and enabled tools.
- **Compact & Resume recovery.** A verified completed answer can supply its handoff after the native page redraws. Saved-summary recovery preserves access to the original terminal without restarting its command.
- **Clearer task state.** Temporary connection and silence notices cannot end a running task; stale failure notices can be dismissed without deleting delivery evidence.
- **Artifacts and plugins.** Mermaid diagrams render offline with editable source and exports, generated images retain completion, and plugin discovery returns bounded results with exact schemas available separately.

See the [0.7.0 release notes](docs/release-notes/v0.7.0.md) and [acceptance record](docs/release-acceptance/v0.7.0.md) for the changes and validation scope. Windows and Linux builds and package checks passed; remaining native Linux acceptance was not completed for this release.

### Historical 0.7.0 limitations

- Some chats can show an older or incomplete app transcript even when the complete native reply is saved. Synchronization is still under investigation.
- Initial model preparation can stall during Compact & Resume. Saved-summary recovery passed, while the cause of the first-attempt timeout remains unproved. For an abandoned attempt with a saved summary, expand its **Compact & Resume** row and choose **Open a new chat with this summary**.

## Experimental local OneCode API

OneCode offers an opt-in **Experimental** loopback OpenAI-compatible API so IDEs and other programs on the same computer can use the OneCode agent. `/v1/models` advertises `onecode`, `onecode-chatgpt`, `onecode-gemini` and `onecode-claude`. `/new`, `/provider` and `/session` control durable chats, while IDE requests retain their own project/thread sessions and provider affinity. JetBrains retrieval/title helper requests are handled locally so they do not create provider turns or delay the coding request.

The durable OneCode session owns chat history, so IDE system/current-file context is preserved without replaying earlier assistant/tool transcript into every turn. When an IDE project already matches an approved OneCode project/root, the API binds that session to the normal project owner and OneCode can read, patch and run the project files directly; otherwise it returns the IDE-native edit/snippet format until that folder is approved once.

The API remains off by default and binds no listener while disabled. Its per-device bearer key is stored in OS-encrypted credential storage and survives compatible updates; the trusted desktop can copy or rotate it without displaying it. Live capability discovery reflects new skills/plugins and permission changes without restarting the API. See [OneCode API (Experimental)](docs/ONECODE-API.md) and the [0.6.3 release notes](docs/release-notes/v0.6.3.md).

## What's new in 0.6.1

Terminal-storage refusals now include a bounded, sanitized cause while preserving the existing fail-closed rule: if durable terminal custody is unavailable, no command starts. OneCode exposes only known errno categories or already-safe path-free custody diagnostics; raw host paths and retained terminal data stay private. The release ships only verified Windows and Linux application capsules and keeps the minimum compatible complete base at 0.5.9. See [0.6.1 notes](docs/release-notes/v0.6.1.md) and the [hotfix update guide](docs/HOTFIX-UPDATES.md).

## What's new in 0.6.0

Recoverable history access, verified installation-adjacent Windows data, resumable update downloads, faster Remote startup, and improved Linux text and download progress. Both platform capsules are built and checked in GitHub against the existing compatible base. See [0.6.0 notes](docs/release-notes/v0.6.0.md).

## What's new in 0.5.0

OneCode now ships as a full Windows + Linux release. Linux gains AppImage/DEB packaging and a verified application-hotfix foundation for future compatible AppImage updates. The release also fixes Linux embedded-browser sizing/positioning, keeps fresh task authorization inside authenticated Core execution for plans/plugins/sub-agents, lets you click an attached image to preview it before Send, and bundles the supported Linux speech-recognition runtime. It includes the accepted connector, Tailscale, transcript and long-response reliability repairs from the Linux port and 0.4.8. See [0.5.0 notes](docs/release-notes/v0.5.0.md).

## What's new in 0.4.8

An explicit Continue or steering message stops the exact unresolved provider turn even after its activity display expires, then waits for the native end before sending. Long tool responses stream keepalive comments through the connector, including modern clients. Interrupted proxy streams close as failures; no uncertain operation is replayed. See [notes](docs/release-notes/v0.4.8.md) and [validation](docs/release-acceptance/v0.4.8.md).

## What's new in 0.4.7

Steering retains the accepted correction's turn when the previous native message is temporarily unreadable, restoring working state and local tool access. Normal no-progress recovery uses a 90-second window, and exactly acknowledged ChatGPT inputs can receive one guarded refresh even before their first tool call. New progress, another question, Stop, approvals, active tools and disabled recovery still take priority. The correction is never resent automatically. See [notes](docs/release-notes/v0.4.7.md) and [validation](docs/release-acceptance/v0.4.7.md).

## What's new in 0.4.6

An acknowledged message now registers its turn even when its browser bubble is mounted but temporarily unreadable. This repairs a case where a long handoff arrived with fresh authorization but local tools waited two minutes and rejected it because the turn was missing. Recovery retains the exact accepted chat/message and does not resend the task or relax authorization. The Companion recorder updates with the application. See [release notes](docs/release-notes/v0.4.6.md) and [validation](docs/release-acceptance/v0.4.6.md).

## What's new in 0.4.5

Hotfix downloads report progress as bytes arrive, with 100% reserved for verified, staged files. Installer downloads stay pinned to the selected release, so a newly published hotfix cannot redirect an in-progress full update to a release without an installer.

After 0.4.5, if a hotfix requires a full release you missed, the updater verifies and downloads both. One **Install when done** action closes OneCode, installs the required base, applies the hotfix and reopens only the final version. A compatible installation still downloads just the small hotfix. Every full release is built from the cumulative source and retains earlier hotfix fixes, including connection repairs and **What's new**. See [release notes](docs/release-notes/v0.4.5.md), [validation](docs/release-acceptance/v0.4.5.md) and [hotfix guide](docs/HOTFIX-UPDATES.md).

## What's new in 0.4.4

The existing **What's new** pane now includes current OneCode release highlights. It opens once after an update restarts, waits for another open dialog to close, and can be reopened from **Settings → General → What's new → View changes**. Full release notes opens the exact installed version's GitHub release.

0.4.4 is an application hotfix release: the internal updater downloads the smaller verified bundle and activates it after work finishes and OneCode restarts. It includes the connection fixes and hotfix support from 0.4.3. No new full installer is needed for a compatible 0.4.3 installation. See the [0.4.4 notes](docs/release-notes/v0.4.4.md), [validation record](docs/release-acceptance/v0.4.4.md) and [hotfix guide](docs/HOTFIX-UPDATES.md).

## What's new in 0.4.3

Public checks no longer cut off a healthy HTTPS/MCP reply after four seconds. Slow responses have their own timeout result instead of being labelled TLS failures.

Windows 0.4.3 also enables smaller application hotfix updates through the ordinary internal updater. Compatible hotfixes download an application bundle, wait for work to finish and activate after a verified restart. Native runtime changes still require a complete installer. See the [0.4.3 release notes](docs/release-notes/v0.4.3.md) and [hotfix guide](docs/HOTFIX-UPDATES.md).

## Earlier connection recovery

If the connector works locally but public access fails during TLS, **Settings → Connection → Repair public connection** can restart Tailscale with Windows administrator consent. This briefly interrupts Tailscale connections, preserves the existing routes and URLs, and checks public HTTPS and MCP again before showing Connected. Repeated clicks share one repair; background checks never launch administrator prompts.

Failed public checks now show Checking instead of remaining Connected. This Windows recovery applies to both ChatGPT and Gemini connectors. See the [0.4.2 release notes](docs/release-notes/v0.4.2.md) and [validation record](docs/release-acceptance/v0.4.2.md).

## What's new in 0.4.1

Fixes a Tailscale connector that could remain **Connecting** on hotspots and other networks where Google DNS over HTTPS is unreachable. OneCode now requests Cloudflare's JSON DNS API with its required media type and accepts the JSON response formats used by both resolvers. Either working resolver can complete the existing public HTTPS and MCP checks independently.

The fix applies to both ChatGPT and Gemini connectors on every updated installation. It preserves saved connector URLs, private Remote routes, permissions and chats. See the [0.4.1 release notes](docs/release-notes/v0.4.1.md) and [validation record](docs/release-acceptance/v0.4.1.md).

## What's new in 0.4.0

OneCode Core brings files, terminal, browser/window control, managed skills and installed MCP plugins together. Both providers can import skills, install plugins, discover newly enabled tools in existing chats, and save recurring checks that send a message at the requested interval until cancelled. Remote new chats retain their selected project, and native steering waits for Stop to complete before sending a correction.

Both providers can present approved local photos and MP4/WebM videos inline, including videos generated by local tools. Video presentations support files up to 128 MiB and play on desktop and authenticated Remote. Interactive Core previews, native image cards and recovered PNG previews retain their recorded ownership. Gemini native image export saves a rendered PNG.

Cold-boot and network recovery now wait through transient Tailscale daemon failures. Remote verifies its retained private route after an interruption; stalled browser requests end with an actionable error instead of remaining Connecting indefinitely. A network, carrier or sign-in requirement can still prevent access; OneCode does not bypass those requirements. See [0.4.0 release notes](docs/release-notes/v0.4.0.md).

Existing chats can discover newly enabled tools through Core without creating another chat. Each installation keeps its own connector URL and existing permissions. Legacy Desktop and Plugins endpoints remain compatible.

The optional Gemini backend skill is now named **onecode-gemini**. It is separate from task skills installed in OneCode. Browser backend skills never grant additional permissions.

OneCode can start Tailscale installation through Windows Package Manager and open the installed account UI. Complete the native installer and sign-in prompts. If native setup is unavailable, use the official download link; OneCode detects completed setup and continues its existing MCP or Remote connection checks.

## What's new in 0.3.8.2

- New messages wake the selected browser again when the connector becomes ready. A fresh Gemini chat can open its native account home when no Gemini page is open; existing chats retain their account and conversation.
- Tailscale startup survives unrelated settings saves. Public readiness checks use independent DNS resolvers and accept a complete initialize reply without waiting for its event stream to close. Transient daemon startup states retry without opening another login.
- Long, silent Gemini replies can recover through the existing page-repair flow after ten minutes without meaningful output. Recovery requires the exact acknowledged task and current question, respects longer thinking windows, and never resends the task. New output, a final reply, approvals or Stop prevent the silent-reply repair.

The 0.3.8.1 setup fixes are included:

- Windows setup detects Chrome/Chromium, Edge, Brave and Firefox in custom folders and on other drives through registered locations, PATH and running browser executables.
- Choosing a browser saves it before sign-in opens, so selecting Edge cannot reuse a previous Brave choice. Pending or rejected saves cannot launch the previous browser.
- **Locate browser executable…** supports portable or unregistered Windows installs, with a saved path for each browser family.

The 0.3.8 remote improvements are included:

- Mobile remote settings fit the screen: category buttons wrap, controls stay reachable, and the page scrolls vertically without sideways panning.
- Bookmark the remote link once. Its encrypted access key and private port are retained across restarts, updates, and turning Remote off and on.
- Opening the bookmark reuses or renews that browser's connection. Messages and other actions are never automatically replayed.
- If another route takes the saved port, **Settings → Remote → Refresh link** selects a free private port. Copy the replacement link and update your bookmark; the conflicting route is preserved.

These earlier repairs are included in 0.4.4. Historical details remain in the [0.3.8.2 release notes](https://github.com/hassanradwannn/OneCode/releases/tag/v0.3.802).

## Work with your own provider account

Keep chats and projects together, delegate workers, use account-available models, and access local files, terminals, plugins and skills. The model picker refreshes from the selected native account and excludes locked models. Keep the provider's current selection or deliberately choose an observed model and thinking level.

Component previews support the bundled React, Tailwind, Lucide and Recharts libraries and artifact-local imports. Unsupported packages, external services and provider-only runtime APIs show a preview error while preserving editable source. Native artifact capture requires actual exposed source/export controls; a model's statement that it created an artifact does not prove the bytes reached OneCode.

**Computer use** is available from Plugins. OneCode reuses an existing CUA Driver installation and daemon, or downloads the official driver during an explicit installation. Chats can also read locally saved session history through Core tools.

## Install

1. **Windows x64:** run the [0.8.3 installer](https://github.com/hassanradwannn/OneCode/releases/download/v0.8.3/OneCode-Setup-x64.exe). **Linux x64:** download the [0.8.3 AppImage](https://github.com/hassanradwannn/OneCode/releases/download/v0.8.3/OneCode-Linux-x64.AppImage) or [0.8.3 DEB](https://github.com/hassanradwannn/OneCode/releases/download/v0.8.3/OneCode-Linux-x64.deb). AppImage installations can use OneCode's internal updater; full DEB/native upgrades remain package-manager-owned.
2. Choose Tailscale or Cloudflare in Setup. For Tailscale, install it from [Tailscale's official download page](https://tailscale.com/download) and sign in with your own account. Linux authorizes the desktop user through the normal polkit/operator flow when OneCode needs to publish its owned route.
3. Open OneCode → **Settings → Setup** and select the browser where you use the provider. Installations on other drives are detected automatically when registered with Windows, on PATH or running. If a portable or custom installation is missed, choose **Locate browser executable…** and select that browser's `.exe`. Follow the connection checks and wait for **Public HTTPS** to pass before copying this PC's connector URL. Public DNS/TLS propagation varies; OneCode retries readiness checks automatically.
4. Load the bundled **OneCode Companion** in Chrome, Edge or Brave using Setup's instructions. Firefox detection/staging does not supply a signed package; see its [availability status](docs/WINDOWS-SETUP.md#firefox). The optional OneCode browser uses the same adapters.
5. Choose **Gemini**, **ChatGPT** or **Claude** in Setup. Add **OneCode Core** in that provider using the exact URL shown, then approve a working folder and choose the tools you want to enable.
6. ChatGPT users with native Skills can export **onecode-chatgpt** from Setup, upload it through ChatGPT Plugins → Skills, enable it, then turn on **Use ChatGPT's onecode-chatgpt skill** in OneCode. Leave the option off when Skills is unavailable.
7. Gemini users can optionally install the bundled **onecode-gemini** skill: save its ZIP, open Gemini → **Customize → Skills**, upload it and choose **Create**. [SKILL.md](resources/skills/onecode-gemini/SKILL.md) is included in the installer and source; the ZIP is also on Releases.
8. With Claude selected, Setup shows **Customize → Connectors → + Add → Add custom connector**, using the shown Name and MCP server URL. Some accounts show these controls under Plugins. Enable the connection once in that account; ordinary messages use it without typing an @ mention or reopening and retoggling its menu. Optionally export **onecode**, upload its ZIP through Skills without renaming the native skill, enable it, then enable the matching OneCode skill option. Leave that option off until the skill is installed in the same account.

Send tasks from OneCode. Your selected provider account supplies the model; no model API key is required for ordinary browser chats. Each person runs OneCode and Tailscale on their own PC. There is no OneCode cloud service to subscribe to or share.

The skill provides reusable instructions; the **Core connector** supplies enabled tools and works without it. Each adapter follows its provider's native connection mechanism. When the optional skill is enabled in OneCode, a confirmed native skill selection can use shorter reusable guidance; an unavailable selector falls back to the same task's prepared full guidance. With the option off, ordinary Core instructions and live task context remain in use. Installing a skill cannot repair an unreachable server URL. Use the same provider account for its connector, optional native skill and managed chats.

For several computers, set **Name for this computer** in Setup before adding its connector. For example, `legion-laptop` publishes `OneCode Core legion-laptop`. Each computer keeps its own URL and credentials. Do not reuse another computer's secret URL or give two devices names that the provider renders identically.

## A connection that survives restarts

**First-time Funnel setup: allow up to 15 minutes before troubleshooting an initially unreachable connector.** Tailscale documents that public DNS propagation can take up to 10 minutes; 15 minutes is a practical first-setup allowance, not a guaranteed tunnel-issuance time. Tailscale can look connected locally while the provider cannot reach public MCP. Keep OneCode and Tailscale running. OneCode keeps checking automatically; wait for public DNS, HTTPS and MCP checks to pass before creating or retrying the connector. If it remains unreachable after that allowance, inspect the specific check and permissions instead of assuming every failure is propagation. [Tailscale propagation guidance](https://tailscale.com/docs/features/tailscale-funnel#dns-propagation).

Tailscale Funnel gives your PC a stable HTTPS address. Once connected, ordinary restarts keep the same connector URL. Keep the same Tailscale device and tailnet, and keep the MCP paths stored in OneCode. The PC, OneCode and Tailscale must be running for tools to work.

Cloudflare quick tunnels remain available as an alternative. Their address changes when the tunnel restarts, so switching to one requires updating the URL in the selected provider.

## Remote access from a browser

On the host PC, open **Settings → Remote**, turn on Remote mode and copy its link. Open that link in a browser on another device connected to your Tailscale. The host PC, OneCode and Tailscale must stay running.

The remote workspace groups chats by OneCode project and can start a chat inside its selected project. It provides history, messages, Stop, plans, model and effort controls, local skill suggestions, images, interactive previews and supported preferences. It uses your host's existing provider connection and tool permissions. Desktop browsers and phones share the same interface with responsive navigation and settings.

Remote mode uses a separate private Tailscale Serve route and access key. Keep its link private. Bookmark the complete copied link, including its fragment. Turning Remote off closes access and browser sessions while preserving the link for re-enabling; **Settings → Remote access** in the remote browser can disconnect that browser alone. Provider MCP connectors keep their separate connection settings.

## Updates and longer tasks

Use **Settings → General → Check for updates**, or let OneCode check in the background. When a verified download is ready, choose **Install when done**. OneCode waits for active work to finish, installs the update and reopens automatically; you can cancel the pending restart. Ordinary Quit leaves the download for later. The matching Companion updates when its chats are idle. Compatible Windows and Linux-AppImage application hotfixes use smaller verified bundles while retaining their immutable native base; incompatible native/runtime changes require a complete installer/AppImage. The Windows updater also validates its cached installer and blockmap before attempting a differential download. DEB installations remain package-manager-owned.

Ask the agent to check a local job at an interval, such as every 60 minutes. It must register the interval and message with Core `automations` and verify the returned schedule ID and next run. OneCode saves the schedule and sends its message into the same chat at each interval until cancelled. Manage or cancel checks in **Settings → Agents & automation → Scheduled checks**, or ask the agent. Keep the PC awake, OneCode running and the provider signed in. A provider-native monitoring card does not register a OneCode check; delivery does not prove a check ran or succeeded.

Updates preserve your profile and saved chats. If an older installation cannot update, run the latest installer once.

Use **Compact & Resume** to continue a long task in a fresh chat. OneCode uses the active provider's receipt flow, saves and verifies the Markdown handoff, then passes it to a new chat on the same provider. Keep the browser and connection running. The context counter is an estimate for OneCode's compaction settings, not the provider's actual remaining quota.

OneCode's local session, each queued input and the provider's native conversation have separate identities. New chats do not borrow another task's UUID or tool authority, and parallel chats retain separate claims, documents and turns. Compact & Resume keeps the task family and saved results while binding its successor through a fresh exact receipt. See [browser conversations and local sessions](docs/PROVIDER-SESSIONS.md).

Developers can follow the current release in the [changelog](CHANGELOG.md), [0.8.3 release notes](docs/release-notes/v0.8.3.md), [verification record](docs/release-acceptance/v0.8.3.md), [API guide](docs/ONECODE-API.md) and [hotfix update guide](docs/HOTFIX-UPDATES.md). Historical notes and acceptance records remain available.

Provider authors should use the [multi-provider compatibility audit](docs/MULTI-PROVIDER-COMPATIBILITY.md) before enabling another browser AI service.

## Before you start

- This release supports **ChatGPT web, Gemini web and Claude web on Windows x64 and Linux x64** through one Companion extension. Native acceptance scope is recorded separately.
- The selected provider decides which models and custom MCP apps your account can use. OneCode cannot grant subscription features or extra usage.
- Fresh installs enable file reading only. Enable commands, writes or desktop control deliberately; those tools act with your Windows user's privileges.
- Enabled tool confirmations on OneCode's own Gemini connector can be handled automatically by its companion. Other apps' approvals are not included.
- The installer is currently unsigned. Windows may show a publisher warning; compare its SHA-256 checksum with the release before running it.
- Keep connector URLs private. They contain access credentials. See [Security](SECURITY.md).

OneCode is open source under the [MIT license](LICENSE), adapted from [the upstream project](https://github.com/totec448-spec/chat-on-steroids) at commit d55f7a45331f0c84671d3b32c44588a40ca9457f. Original copyright notices and third-party licenses are retained.

## Build from source

```sh
npm ci
npm run typecheck
npm run build
```

Use `npm run dev`, `npm run dist:x64` for Windows x64, or `npm run dist:linux:x64` for Linux x64. Required build, packaging and license-verification scripts are included. `npm run verify` checks the published source and build; the automated test suite, its configuration and manual UI fixtures are maintained locally and excluded from Git. Local development checkouts with those files can run `npm test`.

Configured macOS targets remain development/porting targets and require macOS 13 Ventura or newer; macOS is not part of the 0.5.0 published acceptance matrix. Linux AppImages may require their conditional `--no-sandbox` fallback on hosts that prohibit unprivileged user namespaces, reducing process isolation.
