# OneCode

A desktop workspace that connects Gemini to tools on your Windows PC. Work with files, run commands, use your MCP plugins and local skills, and keep your chats and projects together.

**[Download OneCode for Windows](https://github.com/hassanradwannn/OneCode/releases/latest)** · [Setup guide](docs/WINDOWS-SETUP.md)

## Install

1. Download **OneCode-Setup-x64.exe** from Releases and run it.
2. Install [Tailscale](https://tailscale.com/download/windows) on your PC and sign in with your own account.
3. Open OneCode → **Settings → Setup**. Follow the connection checks and wait for **Public HTTPS** to pass before copying this PC's connector URL. A new Tailscale address can take up to ten minutes to appear in public DNS.
4. Load the bundled **OneCode Companion** extension in Brave, Chrome or Edge. Setup opens its folder for you.
5. In Gemini's **Connected apps**, add **OneCode Core** using the URL from Setup. Return to OneCode, approve a working folder and choose the tools you want to enable.
6. Setup also offers the optional **gemini-code** skill: save its ZIP, open Gemini → **Customize → Skills**, upload it and choose **Create**. Enable OneCode's skill option only after installing it in the Google account you use with OneCode. [SKILL.md](resources/skills/gemini-code/SKILL.md) is included in the installer and source; the ZIP is also on Releases.

Send tasks from OneCode. Your Gemini account supplies the model; no Gemini API key is required. Each person runs OneCode and Tailscale on their own PC. There is no OneCode cloud service to subscribe to or share.

The skill provides reusable instructions. The **Core connector** provides access to local tools and works without the skill: OneCode selects it and supplies its tool instructions when sending a task. Installing the skill cannot repair an unreachable server URL. Use the same Google account for the connector, skill and Companion.

## A connection that survives restarts

Tailscale Funnel gives your PC a stable HTTPS address. Once connected, ordinary restarts keep the same connector URL. Keep the same Tailscale device and tailnet, and keep the MCP paths stored in OneCode. The PC, OneCode and Tailscale must be running for tools to work.

Cloudflare quick tunnels remain available as an alternative. Their address changes when the tunnel restarts, so switching to one requires updating the URL in Gemini.

## Updates and longer tasks

OneCode downloads updates from this repository in the background. When an update is ready, choose **Update and restart** when convenient. If work is still running, OneCode waits; you can cancel the pending restart. Ordinary Quit leaves a downloaded update for later. Windows uses smaller differential downloads when a previous installer is cached, with a full download as the fallback. Versions 0.2.6 and earlier need one final manual installer download to enable this updater.

Use **Compact & Resume** to continue a long task in a fresh chat. Gemini saves a Markdown handoff through OneCode Core; OneCode verifies the saved file before passing it to the next chat. Keep the browser and connection running. The context counter is an estimate for OneCode's compaction settings, not Gemini's actual remaining quota.

## Before you start

- This release supports **Gemini web on Windows x64**. Other chat providers are planned.
- Gemini decides which models and connectors your account can use. OneCode shows the choices available to the connected account and cannot grant a subscription feature or extra usage.
- Fresh installs enable file reading only. Enable commands, writes or desktop control deliberately; those tools act with your Windows user's privileges.
- Enabled tool confirmations on OneCode's own Gemini connector can be handled automatically by its companion. Other apps' approvals are not included.
- The installer is currently unsigned. Windows may show a publisher warning; compare its SHA-256 checksum with the release before running it.
- Keep connector URLs private. They contain access credentials. See [Security](SECURITY.md).

OneCode is open source under the [MIT license](LICENSE), adapted from [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids) at commit d55f7a45331f0c84671d3b32c44588a40ca9457f. Original copyright notices and third-party licenses are retained.
