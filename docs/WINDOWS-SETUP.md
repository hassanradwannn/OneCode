# OneCode — set up on another Windows PC

Share **OneCode-Setup-x64.exe**, its distributor-provided SHA256, and this guide. The installer includes the desktop application, companion extension, Cloudflare/search programs, native libraries, and a private Node.js/npm runtime for npm MCP plugins. Your friend does not need this source checkout, your folders, a separate Node installation, or your Google account. The recommended Tailscale connection uses a separate Tailscale installation and the recipient's own account; neither is bundled.

## Requirements and limits

- This installer is for **Windows x64 (Intel/AMD), Windows 10 or later**. Use a Windows version still supported by Microsoft. This is not a 32-bit or ARM64 Windows package. Windows 7/8/8.1 are unsupported. Organization policies and device security software can impose additional restrictions.
- Install a current Brave or Chrome browser. Sign into your own Gemini account there. That account must expose custom connected MCP apps; availability and quotas are controlled by Google. Organization policies may block custom apps, unpacked extensions or debugging permission.
- Internet access is needed for Gemini and the HTTPS tunnel. Installing external plugins may download their packages. Python plugins can download a verified private uv/Python runtime; their host applications and service accounts remain separate prerequisites.
- This app is not code-signed unless the distributor explicitly supplies a signed build. Check the installer hash with the distributor. Do not disable antivirus or Windows security to install it; report a block to the distributor.

## Install and connect

1. Run **OneCode-Setup-x64.exe** as your ordinary Windows user. Keep its per-user install folder unless you have a reason to change it. Start **OneCode** from its shortcut. Do not use another person's development launcher or copy their application-data folder.
2. In **Setup**, select Brave or Chrome. Open its extensions page (`brave://extensions` or `chrome://extensions`), turn on **Developer mode**, and choose **Load unpacked**. Select the companion folder shown by OneCode. A fresh packaged app creates a stable copy under `%APPDATA%\OneCode\extension`; an upgrade may retain its existing GeminiCode folder. Use the path the app actually displays. Keep Developer mode on. After updating the desktop app, reload this same extension if the browser reports an old build.
3. Accept the companion's browser permission prompt after reviewing it. It uses Gemini access, loopback pairing and a scoped debugger rendering lease for background operation. The browser may show a debugging banner during work. Cancelling that lease can pause background progress. No CUA driver is required by the product.
4. Open `gemini.google.com/app` in that browser, using your own account. Reload the page after installing/reloading the companion. Check the app's **Setup** checks for the paired companion and signed-in page.
5. Share a new empty scratch folder in OneCode. Fresh installations start with read permission only and workers off. Deliberately enable file changes/commands in **Workspace** only for work you authorize. Programs run as your Windows user; an approved folder is not an operating-system sandbox for shell commands.
6. In **Setup → Connect**, keep **Tailscale Funnel — recommended** for a new installation. Install [Tailscale for Windows](https://tailscale.com/docs/install/windows), then use its tray icon to sign in to **your own** Tailscale account. Keep Tailscale running. Click **Connect** in OneCode: its CLI, account and Funnel rows show the actual latest checks. If Funnel permission is required, follow the [official Funnel setup](https://tailscale.com/docs/features/tailscale-funnel) or ask your tailnet administrator, then retry Connect. OneCode does not sign you in or change your tailnet's access policy. It refuses to replace a conflicting existing Funnel setup.
7. Wait for **Connected** and an actual published HTTPS URL. Add **OneCode Core** through Gemini's **Settings → Connected apps → Custom** (also available at `https://gemini.google.com/customize/connectors`), using the exact Core URL shown in the app, including its entire path. In tested accounts this secret-URL service connects with OAuth client ID/secret blank; it is not an OAuth authorization server. A Gemini model API key is not required. A different account or organization can require a different setup; do not substitute somebody else's URL or credentials.
8. Return to the desktop composer and start a **fresh** chat with: `Read the approved scratch folder and tell me what is in it. Do not change files.` Confirm an actual read tool result in the app. The composer adds the native Core mention and current session binding; you do not type an @ mention each time.

**Cloudflare alternative:** select **Cloudflare quick tunnel — temporary address** under **Setup → Connect → Connection method**. Its program is bundled and it needs no Tailscale account, but its public hostname changes whenever the connection restarts. Windows may show a firewall request for `cloudflared.exe`. The tested HTTPS tunnel continued working after **Cancel**, leaving inbound public/private network access blocked. Do not turn off the firewall. Close the prompt before continuing setup, since it can block interaction with other windows.

Each PC has its own bridge pairing, secrets and session keys. Do not share connector URLs, binding credentials, profile folders, cookies or logs containing private conversation data. Fresh installations use `%APPDATA%\OneCode`. If that folder does not exist and a previous GeminiCode profile exists, an upgrade keeps using that profile in place; it does not copy or move its secrets. Use the actual folder shown by the app, from this PC's installation and user profile.

## Restarts and updates

Tailscale is the default only for **new installations**. Upgrades keep their chosen connection method. Tailscale's device hostname and OneCode's saved app/connector paths can stay the same across ordinary restarts. Changing the device name, tailnet or saved paths can change the URL; reconnect Gemini whenever the displayed Core URL changes. Tailscale mode requires OS secure storage and keeps **Keep plugin URLs across restarts** enabled. Funnel publishes this app over public HTTPS; possession of a connector URL is access to that connector, subject to OneCode's live permissions. Keep it private.

The Cloudflare quick tunnel gets a **new public hostname after restarting the connection**. Replace/reconnect Gemini's custom Core app with the new URL shown in Setup. Keeping secret URL paths does not preserve that hostname. Closing the app window normally keeps it running in the tray, while **Quit** stops it.

Automatic updates to the original Chat On Steroids project are disabled. Obtain the next OneCode installer from the same distributor, quit the running app deliberately, install it, then check/reload the bundled companion. The installer retains local app data on uninstall; remove it separately only if you intend to erase your settings, plugins and history.

### Keep a stable HTTPS address with your own tunnel

This is an alternative operator setup, separate from managed Tailscale Funnel and the bundled quick tunnel. You need your own public HTTPS hostname and tunnel/reverse proxy, such as a [named Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/).

1. In **Settings → General → For developers**, enable **Keep plugin URLs across restarts**. This preserves secret path tokens using this PC's secure storage; it cannot preserve a quick-tunnel hostname.
2. In **Setup → Connect → Connection method**, choose **Local only — I run my own tunnel**, then connect. Read the complete current loopback Core URL shown in the app. Its port is the MCP server's port, not the companion bridge port.
3. Route your hostname to that loopback origin, preserving the full request path and streaming responses. The origin must receive a loopback `Host` header; for Cloudflare set [`httpHostHeader`](https://developers.cloudflare.com/tunnel/configuration/) to the loopback host and port shown by the app. Publish no other local services. Follow the tunnel provider's current DNS and credential setup.
4. Add the resulting **HTTPS hostname plus the exact Core path** to Gemini. After an app restart, check the loopback port and update your tunnel's origin if it changed. The hostname and saved path can stay the same; changing either still requires updating Gemini. This app does not run/manage your named-tunnel service for you.

## Plugins, Skills and modes

Attach photos and files through **Add attachments → Add photos & files**, or paste a photo into the composer. CSV files are sent to Gemini as a text copy named `original.csv.txt` because the tested native CSV loader rejected ordinary CSV uploads. The bytes remain unchanged, and app history retains the original filename. Other file types still depend on Gemini's supported formats and limits.

Install plugins through this app. Enabled external MCPs are discovered/called through Core's `plugins` tool; if Core was connected before that wrapper first became available, reconnect Core once. Later plugin additions/removals use live discovery. A custom stdio server needs its executable and arguments on **this PC**, or use its supported Streamable HTTP URL and its own authentication. Another app's MCP configuration and installed services are not imported automatically. Plugins and native dependencies have their own OS/CPU requirements. npm packages requiring blocked lifecycle build scripts need an appropriate prebuilt server or a separately prepared executable; the app does not run npm lifecycle scripts during installation.

The private Node/npm bundle is an app fallback, not a global Node installation. Existing explicit executable paths remain unchanged. Development tools such as Git, project-specific SDKs, browsers downloaded by a plugin, and accounts for remote services may still need their own installation/setup.

Local Skills are listed on demand by reading `/skills/.catalog.json`; then read a returned `SKILL.md`. Later installations appear without reconnecting. Gemini's separate native `gemini-code` skill is optional: leave **Use Gemini's gemini-code skill** off unless you have installed it in that Google account. The app works without it.

**Goal** continues toward the saved objective and can stop when it is satisfied. **Loop** continues until paused; automatic pickup pauses if the exact source turn contains no local MCP tool call. **Plan** drafts editable workflow stages, sends the complete request/workflow first, then queues verification checkpoints. The default browser helper needs no API key. Choosing an API continuation backend requires its own configured provider credential (a keyless custom local endpoint is also supported). Native model availability, message limits and approval controls remain Google's.

## Troubleshooting

- **No tools / disconnected:** check the app connection, current Core URL, selected signed-in browser profile, companion build and fresh Gemini page. A restarted quick tunnel often needs a reconnect. A stale native chat can retain old connector namespaces; test a new app chat.
- **Tailscale cannot connect:** read the three actual check rows in Setup. Install or sign in using Tailscale itself, keep its service running, and ask the tailnet administrator if Funnel is restricted. Retry Connect after completing setup. A detected CLI alone does not prove sign-in, permission or a published URL. Do not reset somebody else's Funnel settings or disable secure storage to bypass a conflict.
- **A plugin fails to start:** check that its host program is installed and the executable/arguments are valid on this PC. npm plugins have a private fallback runtime; reinstall OneCode if its bundled runtime is missing. Remote services can require separate sign-in.
- **Uploads or a mode stalls:** keep the paired browser running, inspect the app's queued delivery/error and Gemini's actual state. Refresh only when no ambiguous send is pending. Do not repeatedly resend an operation whose receipt is unknown.
- **Window minimizes unexpectedly:** this app has no minimize-on-Send preference. Preserve the event time and share the content-free `main window presentation` / `main window send` diagnostic rows with the distributor. Do not treat a forced restore as a fix.

Reference: [Google custom connected app setup](https://support.google.com/gemini/answer/17209137?hl=en), [Tailscale Windows installation](https://tailscale.com/docs/install/windows), [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel).
