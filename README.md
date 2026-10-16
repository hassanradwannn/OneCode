# OneCode

A desktop workspace that connects Gemini to tools on your Windows PC. Work with files, run commands, use your MCP plugins and local skills, and keep your chats and projects together.

**[Download OneCode for Windows](https://github.com/hassanradwannn/OneCode/releases/latest)** · [Setup guide](docs/WINDOWS-SETUP.md)

## Install

1. Download **OneCode-Setup-x64.exe** from Releases and run it.
2. Install [Tailscale](https://tailscale.com/download/windows) on your PC and sign in with your own account.
3. Open OneCode → **Settings → Setup**. Follow the connection checks to enable Tailscale Funnel and copy your connector URL.
4. Load the bundled **OneCode Companion** extension in Brave, Chrome or Edge. Setup opens its folder for you.
5. In Gemini's **Connected apps**, add **OneCode Core** using the URL from Setup. Return to OneCode, approve a working folder and choose the tools you want to enable.

Send tasks from OneCode. Your Gemini account supplies the model; no Gemini API key is required. Each person runs OneCode and Tailscale on their own PC. There is no OneCode cloud service to subscribe to or share.

## A connection that survives restarts

Tailscale Funnel gives your PC a stable HTTPS address. Once connected, ordinary restarts keep the same connector URL. Keep the same Tailscale device and tailnet, and keep the MCP paths stored in OneCode. The PC, OneCode and Tailscale must be running for tools to work.

Cloudflare quick tunnels remain available as an alternative. Their address changes when the tunnel restarts, so switching to one requires updating the URL in Gemini.

## Before you start

- This release supports **Gemini web on Windows x64**. Other chat providers are planned.
- Gemini decides which models and connectors your account can use. OneCode shows the choices available to the connected account and cannot grant a subscription feature or extra usage.
- Fresh installs enable file reading only. Enable commands, writes or desktop control deliberately; those tools act with your Windows user's privileges.
- Enabled tool confirmations on OneCode's own Gemini connector can be handled automatically by its companion. Other apps' approvals are not included.
- The installer is currently unsigned. Windows may show a publisher warning; compare its SHA-256 checksum with the release before running it.
- Keep connector URLs private. They contain access credentials. See [Security](SECURITY.md).

OneCode is open source under the [MIT license](LICENSE), adapted from [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids) at commit d55f7a45331f0c84671d3b32c44588a40ca9457f. Original copyright notices and third-party licenses are retained.
