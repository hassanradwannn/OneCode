# External MCP plugins

## Discovery in existing chats

Core exposes a stable `plugins` discovery/call tool, including before the first plugin is installed.
ChatGPT and Gemini receive the same local-first discovery guidance. When installed tools are
available, ordinary existing-chat turns carry a compact reminder to call `plugins {action:"list"}`
before searching for a plugin elsewhere. Listing without a query avoids confusing a plugin's
display name, such as Knowledge Memory, with its upstream tool names, such as `read_graph`.
Returned schemas remain live; installation, removal and enabled-tool changes are reflected on
the next discovery call. Execution still respects Read-only, Block, Trust and exact caller binding.

This does not automatically install, enable or authenticate a plugin. Provider-hosted chats
outside OneCode's delivery path receive Core's declaration/instructions but not OneCode's
per-turn reminders. An existing provider snapshot from before this stable discovery declaration
may need a one-time Core tool refresh; a new conversation is not the intended recovery path.

The **Plugins** page in OneCode manages external MCP integrations. New installations use
one **OneCode Core** connector per provider and installation. Core exposes permitted local
tools, skills and live plugin discovery through the existing permission controls. Legacy
Desktop and Plugins endpoints remain compatible with previously configured installations.

The [responsible-use notice](../README.md#responsible-use-and-provider-rules) applies to plugins too.
Each external service retains its own terms, permissions and usage limits.

## Setup

1. Complete OneCode Setup and connect the provider to the displayed **OneCode Core** URL.
   Tailscale setup handles the public MCP route; Remote settings use a separate private Serve route.
2. Open **Plugins**, click **+**, and choose a reviewed recipe or a custom MCP server.
   Supply any credentials through the secure fields and complete required service sign-in.
3. A plugin becomes **Ready** after connection and live tool discovery succeed. Blender also
   requires its addon to answer a read-only scene probe.
4. In an existing ChatGPT or Gemini chat, call Core `plugins` with `action: "list"` to see the
   current integrations and schemas. New installations and policy changes are visible on the
   next discovery call; creating a new chat is unnecessary. Calls to disabled tools are refused.
5. If the provider has cached an older Core declaration without plugin discovery, refresh that
   same OneCode Core connector once. Use the configured device-specific connector name.

Models can install requested MCP integrations through Core's plugin installation action when
Command and Create permissions allow it. Installation uses the same manager as the Plugins page;
it cannot grant permissions or complete a service's user sign-in on its own.

## Supported sources

- Pinned npm and Python recipes: Blender MCP, Knowledge Memory, Playwright Browser, Web Fetch and Unity Editor.
  Node.js/npm or Python/uv must be installed where the recipe requires them. CoS installs
  packages into private per-plugin directories and does not install missing system runtimes.
  On Windows, the standard per-user uv directory (`%USERPROFILE%\.local\bin`) is also
  searched, so installing uv there does not require restarting an already-running CoS.
  For custom runtime locations, add the directory to PATH and restart CoS.
- An executable with explicit arguments (no shell interpolation).
- Remote Streamable HTTP MCP URLs, with HTTPS or loopback HTTP. Credentials use encrypted
  storage; do not embed them in URLs or arguments. HeyGen and Recraft use explicit browser OAuth
  authorization. Their hosted services have separate provider terms and account requirements.
- Local MCPB bundles using the upstream manifest parser and configuration expansion.
  Unsupported runtime/manifest setup reports an error rather than inventing a launch command.
- GitHub URLs that match reviewed recipes. Other repositories need an MCPB release or explicit
  package/executable configuration; a repository URL alone is not executable MCP configuration.

Blender needs the community addon installed and enabled in Blender, with its MCP server started
from the viewport sidebar. The catalog includes the upstream addon installation steps. Blender
is a third-party integration, not an official Blender feature supplied by CoS.

## Authority and lifetime

`src/main/plugins/manager.ts` owns installed records, enabled policy, connections, credentials
references and tool routing. `src/main/plugins/installer.ts` owns isolated package installation
and bounded archive extraction. The manager stores metadata through `durable.ts`, credentials
through `secrets.ts`, and preserves upstream package license files in installation directories.

External processes run with the current user's operating-system permissions. They do not inherit
CoS's approved-folder sandbox. CoS read-only mode refuses external plugin calls because upstream
annotations cannot prove that an external process is unable to mutate. Tool annotations are
otherwise relayed without making them more permissive.

The Plugins surface forwards complete JSON schemas and MCP results through the SDK and the
existing request attribution/recording dispatcher. Upstream tool names are preserved; conflicting declarations are excluded rather than renamed. Publication is bounded by 256 tools and
250 KB of schemas across all enabled plugins; tools past that are listed as not exposed. A server may
declare more (up to 2,048 tools or 8 MB, an emergency guard against pathological catalogs): it is
installed, publishes what fits, and switching tools off on its page makes room for the ones you want.
The installed tool list distinguishes enabled tools from those actually published within the limit.
Transport failures never automatically retry tool calls. A failed mutation can already have
taken effect; inspect its state before deciding to retry.

Fresh installs contain no plugins. Installed and enabled plugins keep their connection for the app's lifetime, until disabled or uninstalled. App startup restores those connections in the background without waiting for external server discovery before showing chats. Cached tool declarations remain available during startup; every call rechecks current enabled policy.

Restart reconnects/discovers a server. Configure changes its settings and write-only credentials.
Each plugin also has **Longest call** in Configure: a per-installation MCP tool deadline in seconds,
default **120 seconds** and configurable from 1 second up to **30 minutes**. It is stored separately
from the server's environment variables and restored after app restart. Changing only Longest call
does not reconnect the plugin or interrupt a tool already running; that call keeps its previously
chosen deadline. Calls with or without progress are bounded by the same total deadline. MCP
progress extends the SDK's idle timer, while a separate abort signal enforces the overall maximum.
On timeout the SDK sends cancellation for just that request; CoS neither disconnects an otherwise
healthy plugin nor automatically retries a potentially completed operation. ChatGPT may have its
own shorter waiting limit: changing Longest call locally does not guarantee ChatGPT will wait for
the full 30 minutes or show a late result in the original conversation.
Update stages a replacement and requires a successful connection before committing it; failure
restores the prior installation. Package versions stay pinned to reviewed recipes; custom version
changes use Configure. Uninstall stops the process and removes installation data and credentials.
Knowledge Memory retains its data across updates in a stable per-plugin data directory.

## Legal notices

CoS remains MIT licensed. Settings provides the bundled Third-party Notices, generated from
production npm dependencies by `scripts/generate-third-party-notices.mjs`. Platform binary
notices remain alongside their binaries. See [catalog artwork attribution](plugin-licenses.md).
External plugin licenses are shown per installation and remain separate from CoS's own license.
Reviewed labels apply only to the exact catalog distribution. Knowledge Memory's reviewed
MIT/Apache transition supersedes its incomplete manifest label; a custom version must supply
its own license information. `npm run verify:notices` checks installed production versions,
license material and catalog notice hashes on every CI platform without rewriting the local
notice file. Packaging regenerates the notices for its installed dependencies.

Notice completeness is not binary-release clearance. Exact corresponding-source and
replacement obligations for LGPL/MPL native dependencies remain a separate release check;
see [the audit](plugin-notice-audit.md).

## Validation

The plugin suites cover archive path and expansion limits, installation, subprocess discovery,
schema/result preservation, credential redaction, durable disabled state, rollback, and routing
through the real loopback MCP endpoint. `COS_PLUGIN_LIVE_TEST=1` enables an opt-in network test
of the pinned upstream Memory server. See [the notice and validation audit](plugin-notice-audit.md).
