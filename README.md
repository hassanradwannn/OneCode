# OneCode

A desktop workspace for AI providers and local tools on Windows. Work with files, run commands, use MCP plugins and local skills, and keep chats and projects together.

**[Download OneCode for Windows](https://github.com/hassanradwannn/OneCode/releases/latest)** · [Setup guide](docs/WINDOWS-SETUP.md)

## What's new in 0.3.2

- Shared settings and the Companion use provider/agent wording. Provider names remain in the selector and service-specific connection instructions.
- Existing chats retain their provider, model choices and trust settings. Different providers use independent local MCP endpoints. Ordinary input in separate chats also runs independently when a call has no proven chat identifier; global update and compaction safety checks remain conservative.
- Sign-in detection reads the selected provider's rendered account controls. A signed-out page's composer does not count as an authenticated account.
- Custom device connector names are published exactly in MCP metadata. Native connector selection accepts a unique title-cased, dash-to-space presentation of that full name and refuses ambiguous or different-device matches.
- The Companion dismisses the recognized English response-comparison feedback question. It requires the question, both options and a separate two-button feedback footer; thinking controls and unknown layouts are left untouched.
- Manual update checks, verified Windows installation/relaunch and automatic Companion migration are included.

## Install

1. Download **OneCode-Setup-x64.exe** from Releases and run it.
2. Choose Tailscale or Cloudflare in Setup. For Tailscale, [install it](https://tailscale.com/download/windows) and sign in with your own account.
3. Open OneCode → **Settings → Setup**. Follow the connection checks and wait for **Public HTTPS** to pass before copying this PC's connector URL. Public DNS/TLS propagation varies; OneCode retries readiness checks automatically.
4. Load the bundled **OneCode Companion** extension in Brave, Chrome or Edge. Setup opens its folder for you.
5. Choose **Gemini** or **ChatGPT** in Setup. Add **OneCode Core** in that provider using the exact URL shown, then approve a working folder and choose the tools you want to enable.
6. Gemini users can optionally install the bundled **gemini-code** skill: save its ZIP, open Gemini → **Customize → Skills**, upload it and choose **Create**. [SKILL.md](resources/skills/gemini-code/SKILL.md) is included in the installer and source; the ZIP is also on Releases.

Send tasks from OneCode. Your selected provider account supplies the model; no model API key is required for ordinary browser chats. Each person runs OneCode and Tailscale on their own PC. There is no OneCode cloud service to subscribe to or share.

The skill provides reusable instructions. The **Core connector** provides access to local tools and works without the skill: OneCode selects it and supplies its tool instructions when sending a task. Installing the skill cannot repair an unreachable server URL. Use the same provider account for its connector, optional native skill and managed browser chats.

For several computers, set **Name for this computer** in Setup before adding its connector. For example, `legion-laptop` publishes `OneCode Core legion-laptop`. Each computer keeps its own URL and credentials. Do not reuse another computer's secret URL or give two devices names that the provider renders identically.

## A connection that survives restarts

Tailscale Funnel gives your PC a stable HTTPS address. Once connected, ordinary restarts keep the same connector URL. Keep the same Tailscale device and tailnet, and keep the MCP paths stored in OneCode. The PC, OneCode and Tailscale must be running for tools to work.

Cloudflare quick tunnels remain available as an alternative. Their address changes when the tunnel restarts, so switching to one requires updating the URL in the selected provider.

## Updates and longer tasks

Use **Settings → General → Check for updates**, or let OneCode check in the background. When a verified download is ready, choose **Install when done**. OneCode waits for active work to finish; you can cancel the pending restart. Ordinary Quit leaves the download for later. The matching Companion updates when its chats are idle. Windows can fall back from a differential download to the complete installer.

Some old 0.2.9 installers omitted `resources/app-update.yml`. If an update check reports that missing file, install the current release manually once. Current packages include and validate it. The older compatibility build `0.2.905` displays as `0.2.9.5`; this release uses `0.3.2` consistently.

Use **Compact & Resume** to continue a long task in a fresh chat. OneCode uses the active provider's receipt flow, saves and verifies the Markdown handoff, then passes it to a new chat on the same provider. Keep the browser and connection running. The context counter is an estimate for OneCode's compaction settings, not the provider's actual remaining quota.

Current native acceptance covers sign-in, provider persistence, model discovery and ordinary file/terminal tools. Long-running Goal/Loop/Plan and compaction flows have not all received a fresh end-to-end acceptance run for this release. Some current ChatGPT MCP transports omit request IDs; exact per-chat local tool attribution and features requiring those IDs remain limited.

Provider authors should use the [multi-provider compatibility audit](docs/MULTI-PROVIDER-COMPATIBILITY.md) before enabling another browser AI service.

## Before you start

- This release supports **Gemini web and ChatGPT web on Windows x64** through one Companion extension.
- The selected provider decides which models and custom MCP apps your account can use. OneCode cannot grant subscription features or extra usage.
- Fresh installs enable file reading only. Enable commands, writes or desktop control deliberately; those tools act with your Windows user's privileges.
- Enabled tool confirmations on OneCode's own Gemini connector can be handled automatically by its companion. Other apps' approvals are not included.
- The installer is currently unsigned. Windows may show a publisher warning; compare its SHA-256 checksum with the release before running it.
- Keep connector URLs private. They contain access credentials. See [Security](SECURITY.md).

OneCode is open source under the [MIT license](LICENSE), adapted from [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids) at commit d55f7a45331f0c84671d3b32c44588a40ca9457f. Original copyright notices and third-party licenses are retained.
