# Security

OneCode connects a cloud chat to your local Windows account. Approve only the folders and capabilities you want to expose. Fresh installations enable reading only and start with workers, unattributed calls and automatic connection disabled.

File tools check approved folders. Shell commands run with your normal Windows privileges and are not a filesystem sandbox. Optional desktop tools can observe or control your desktop. Enable these capabilities only when you intend to use them.

MCP services bind to loopback. Tailscale Funnel or your chosen tunnel supplies public HTTPS reachability; it does not authenticate the cloud caller. Secret connector paths and revocable per-conversation capabilities protect local tool dispatch. Keep connector URLs private. OneCode does not implement an OAuth authorization server.

The browser companion is paired separately. Its required debugger permission supports scoped background rendering of its owned Gemini tabs. Automatic tool approvals apply only to enabled tools on the exact OneCode connector involved. The companion does not grant extra local permissions or bypass provider usage limits.

Credentials use Electron's secure storage (DPAPI on Windows). Local chat history and tool recordings are separate files and are not encrypted by that credential store. Anyone with access to your Windows account may be able to read them. Removing the application does not delete your history.

Release binaries are currently unsigned. Verify checksums from the release. Follow Gemini's account restrictions and provider terms; OneCode cannot change quota or account entitlements.

For a vulnerability, use this repository's private vulnerability reporting when available. Do not post live credentials or exploitable private details in a public issue. Include the app version and a small reproduction with synthetic data. Rotate any credentials that were exposed.
