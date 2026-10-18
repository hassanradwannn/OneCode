# OneCode

A desktop workspace for AI providers and local tools on Windows. Work with files, run commands, use MCP plugins and local skills, and keep chats and projects together.

**Latest release: [OneCode 0.3.6](https://github.com/hassanradwannn/OneCode/releases/tag/v0.3.600)** · **[Download for Windows](https://github.com/hassanradwannn/OneCode/releases/latest/download/OneCode-Setup-x64.exe)** · [Setup guide](docs/WINDOWS-SETUP.md)

The current release is available for **Windows x64**, with **ChatGPT web and Gemini web** through one Companion extension.

## What's new in 0.3.6

- **CUA screenshots:** native screenshots reach the model as images instead of exhausting the text output limit.
- **Optional ChatGPT skill:** export reusable instructions in Setup, then confirm native activation to reduce repeated guidance.
- **Progress placement:** late historical commentary stays with its completed response.
- **Matching handoff flow:** Gemini and ChatGPT both return Markdown for OneCode to save and carry into a fresh chat, without a tool approval to save it.
- **Approval continuity:** native approval replies retain the original task, and enabled tools are recognized by their published titles.
- **Fresh Gemini chats:** preparation survives the controlled empty-editor remount before initialization.
- **Attachments:** repeated ChatGPT uploads confirm correctly when the provider renames a duplicate file.
- **First-message authorization:** preserves the exact task through browser preparation and enables tools in the resumed chat without requiring another “continue” message.
- **Faster connections:** independent Tailscale readiness checks avoid waiting for a slow network route when another works.
- **Clearer context and status:** the context meter is a local reference; shared notices use provider-neutral wording.

See the [0.3.6 release notes](docs/release-notes/v0.3.6.md) and [changelog](CHANGELOG.md).

## Work with your own provider account

Keep chats and projects together, delegate workers, use account-available models, and access local files, terminals, plugins and skills. The model picker refreshes from the selected native account, excludes locked models and offers one Automatic choice.

**Computer use** is available from Plugins. OneCode reuses an existing CUA Driver installation and daemon, or downloads the official driver during an explicit installation. Chats can also read locally saved session history through Core tools.

## Install

1. Download **OneCode-Setup-x64.exe** from Releases and run it.
2. Choose Tailscale or Cloudflare in Setup. For Tailscale, [install it](https://tailscale.com/download/windows) and sign in with your own account.
3. Open OneCode → **Settings → Setup**. Follow the connection checks and wait for **Public HTTPS** to pass before copying this PC's connector URL. Public DNS/TLS propagation varies; OneCode retries readiness checks automatically.
4. Load the bundled **OneCode Companion** extension in Brave, Chrome or Edge. Setup opens its folder for you.
5. Choose **Gemini** or **ChatGPT** in Setup. Add **OneCode Core** in that provider using the exact URL shown, then approve a working folder and choose the tools you want to enable.
6. ChatGPT users with native Skills can export **onecode-chatgpt** from Setup, upload it through ChatGPT Plugins → Skills, enable it, then turn on **Use ChatGPT's onecode-chatgpt skill** in OneCode. Leave the option off when Skills is unavailable.
7. Gemini users can optionally install the bundled **gemini-code** skill: save its ZIP, open Gemini → **Customize → Skills**, upload it and choose **Create**. [SKILL.md](resources/skills/gemini-code/SKILL.md) is included in the installer and source; the ZIP is also on Releases.

Send tasks from OneCode. Your selected provider account supplies the model; no model API key is required for ordinary browser chats. Each person runs OneCode and Tailscale on their own PC. There is no OneCode cloud service to subscribe to or share.

The skill provides reusable instructions. The **Core connector** provides access to local tools and works without the skill: OneCode selects it and supplies its tool instructions when sending a task. Installing the skill cannot repair an unreachable server URL. Use the same provider account for its connector, optional native skill and managed browser chats.

For several computers, set **Name for this computer** in Setup before adding its connector. For example, `legion-laptop` publishes `OneCode Core legion-laptop`. Each computer keeps its own URL and credentials. Do not reuse another computer's secret URL or give two devices names that the provider renders identically.

## A connection that survives restarts

Tailscale Funnel gives your PC a stable HTTPS address. Once connected, ordinary restarts keep the same connector URL. Keep the same Tailscale device and tailnet, and keep the MCP paths stored in OneCode. The PC, OneCode and Tailscale must be running for tools to work.

Cloudflare quick tunnels remain available as an alternative. Their address changes when the tunnel restarts, so switching to one requires updating the URL in the selected provider.

## Updates and longer tasks

Use **Settings → General → Check for updates**, or let OneCode check in the background. When a verified download is ready, choose **Install when done**. OneCode waits for active work to finish; you can cancel the pending restart. Ordinary Quit leaves the download for later. The matching Companion updates when its chats are idle. Windows can fall back from a differential download to the complete installer.

If an old installation reports missing updater metadata, install the current release manually once. **0.3.6** uses package/updater version **0.3.600**, which upgrades from **0.3.500** (displayed as 0.3.5). Updates preserve your profile and saved chats.

Use **Compact & Resume** to continue a long task in a fresh chat. OneCode uses the active provider's receipt flow, saves and verifies the Markdown handoff, then passes it to a new chat on the same provider. Keep the browser and connection running. The context counter is an estimate for OneCode's compaction settings, not the provider's actual remaining quota.

The installed 0.3.6 Windows candidate passed source and package checks, preserved recorded chats, and received user confirmation after the requested ChatGPT and Gemini manual tests. See [release acceptance](docs/release-acceptance/v0.3.6.md) for the scope of validation.

Provider authors should use the [multi-provider compatibility audit](docs/MULTI-PROVIDER-COMPATIBILITY.md) before enabling another browser AI service.

## Before you start

- This release supports **Gemini web and ChatGPT web on Windows x64** through one Companion extension.
- The selected provider decides which models and custom MCP apps your account can use. OneCode cannot grant subscription features or extra usage.
- Fresh installs enable file reading only. Enable commands, writes or desktop control deliberately; those tools act with your Windows user's privileges.
- Enabled tool confirmations on OneCode's own Gemini connector can be handled automatically by its companion. Other apps' approvals are not included.
- The installer is currently unsigned. Windows may show a publisher warning; compare its SHA-256 checksum with the release before running it.
- Keep connector URLs private. They contain access credentials. See [Security](SECURITY.md).

OneCode is open source under the [MIT license](LICENSE), adapted from [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids) at commit d55f7a45331f0c84671d3b32c44588a40ca9457f. Original copyright notices and third-party licenses are retained.

## Build from source

```sh
npm ci
npm run typecheck
npm run build
```

Use `npm run dev` for development or `npm run dist:x64` to package Windows x64. Required build, packaging and license-verification scripts are included. `npm run verify` checks the published source and build; the automated test suite, its configuration and manual UI fixtures are maintained locally and excluded from Git. Local development checkouts with those files can run `npm test`.

macOS and Linux packaging configurations are present, but this release's installed acceptance covers Windows x64. Configured macOS targets require macOS 13 or newer. Linux AppImages may require their conditional `--no-sandbox` fallback on hosts that prohibit unprivileged user namespaces, reducing process isolation.
