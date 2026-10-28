import { providerText } from './provider-text.js';
/**
 * What's New: the highlights of the version the app just updated to, once (#1172).
 *
 * The highlights are the release notes' own Highlights, shortened, and written in each release PR
 * next to the notes. Literal `t()` calls keep the catalog audit able to see each key, so every
 * language ships them like the rest of the interface. A version without an entry shows nothing.
 */
import { releaseNotesUrl, whatsNewAction } from '../shared/whats-new.js';
import { channelVersion } from '../shared/build-channel.js';
import { $, el, icon, run } from './dom.js';
import { t, ui } from './i18n.js';
import { primaryShortcut } from './shortcuts.js';

interface Highlight { icon: string; title: () => string; text: () => string }
interface Release { lead: () => string; highlights: Highlight[] }

const RELEASES: Readonly<Record<string, Release>> = {
  '0.7.3': {
    lead: () => t('Recover Windows updates blocked by process records from before a reboot.'),
    highlights: [
      { icon: 'i-retry', title: () => t('Reliable update shutdown'), text: () => t('Windows boot evidence reconciles old process records before the ordinary exact WSL checks. Unresolved records now show an update error while the app remains open.') },
      { icon: 'i-settings', title: () => t('First-time connection guidance'), text: () => t('Allow up to 15 minutes for first-time Funnel provisioning and public verification. Keep OneCode and Tailscale running while the checks continue.') }
    ]
  },
  '0.7.27': {
    lead: () => t('Deliver the selected-chat readiness repair through a complete Beta update.'),
    highlights: [
      { icon: 'i-chat', title: () => t('Readiness follows delivery'), text: () => t('A confirmed Send in the exact selected conversation clears an older timed-out provider-tab warning instead of leaving the banner stuck.') },
      { icon: 'i-retry', title: () => t('Complete updater register'), text: () => t('Beta release builds now finalize the canonical cross-platform checksum register before publication, so existing installs can verify and consume the candidate.') }
    ]
  },
  '0.7.26': {
    lead: () => t('Keep selected-chat readiness aligned with successful native delivery.'),
    highlights: [
      { icon: 'i-chat', title: () => t('Readiness follows delivery'), text: () => t('A confirmed Send in the exact selected conversation clears an older timed-out provider-tab warning instead of leaving the banner stuck.') },
      { icon: 'i-retry', title: () => t('Read-only recovery'), text: () => t('Late readiness reconciliation checks the existing selection only. It does not reopen, focus, reload or resend the provider tab.') }
    ]
  },
  '0.7.25': {
    lead: () => t('Keep message delivery moving during browser preparation and progress updates.'),
    highlights: [
      { icon: 'i-chat', title: () => t('Independent chats'), text: () => t('A stalled browser tab no longer holds up other chats. Steer keeps the exact recorded question when the browser redraws it, while preserving the original local process and output.') },
      { icon: 'i-retry', title: () => t('Manual handoff'), text: () => t('Manual compaction retains a verified completed answer through redraws and changes between its verified native headers, while keeping the current question and local results attached.') }
    ]
  },
  '0.7.2': {
    lead: () => t('Improve browser recovery, task authorization and Tailscale setup.'),
    highlights: [
      { icon: 'i-chat', title: () => t('Recover after inactivity'), text: () => t('Browser maintenance keeps its fallback wake running and recovers from a stalled tab query. Confirmed delivery clears stale readiness warnings.') },
      { icon: 'i-retry', title: () => t('Keep task connections alive'), text: () => t('Tool connections stream keepalives while waiting for the exact task receipt. Temporary session recovery no longer permanently retires that task grant.') },
      { icon: 'i-settings', title: () => t('Clearer connection setup'), text: () => t('Tailscale setup links directly to DNS and Funnel controls. A temporary public check failure keeps an established connector visible with an explanation.') }
    ]
  },
  '0.7.1': {
    lead: () => t('Preserve the recorded source question while the browser redraws a running chat.'),
    highlights: [
      { icon: 'i-chat', title: () => t('Steer through chat redraws'), text: () => t('Keeps the exact recorded question and turn when its native row leaves the rendered page. A newer question or changed chat still stops delivery.') },
      { icon: 'i-retry', title: () => t('Delivery diagnostics'), text: () => t('Shows the current browser maintenance and message pickup stages in Companion details and diagnostic reports.') }
    ]
  },
  '0.7.0': {
    lead: () => t('Keep message delivery moving during browser preparation and progress updates.'),
    highlights: [
      { icon: 'i-chat', title: () => t('Independent chats'), text: () => t('A stalled browser tab no longer holds up other chats. Steer keeps the exact recorded question when the browser redraws it, while preserving the original local process and output.') },
      { icon: 'i-chat', title: () => t('Responsive message delivery'), text: () => t('Grouped replies retain their own question even when the provider hides it from view. Acknowledged follow-ups keep the correct task through redraws and delayed native metadata. Generated images keep their own completion proof. Withdrawing a message before Send preserves the preceding task and its results.') },
      { icon: 'i-retry', title: () => t('Manual handoff'), text: () => t('Manual compaction retains a verified completed answer through redraws and changes between its verified native headers, while keeping the current question and local results attached.') },
      { icon: 'i-retry', title: () => t('Gemini opening recovery'), text: () => t('An owned preparation can refresh once and recover an empty replacement page within its original deadline. Recovery cannot replay an uncertain task Send.') }
    ]
  },
  '0.6.23': {
    lead: () => t('Steer through the provider’s native composer.'),
    highlights: [
      { icon: 'i-chat', title: () => t('Steer during local work'), text: () => t('Delivers your message through the native composer without waiting for a separate Stop gate. Existing tool calls and terminal output remain attached to their original task.') },
      { icon: 'i-chat', title: () => t('Rendered diagrams'), text: () => t('Renders Mermaid diagram artifacts offline while keeping their editable source and existing exports.') },
      { icon: 'i-retry', title: () => t('Compact tool discovery'), text: () => t('Keeps plugin inventories bounded and retrieves exact schemas separately so discovery leaves room for the results you requested.') }
    ]
  },
  '0.6.22': {
    lead: () => t('Confirm the selected Gemini model through native menu changes.'),
    highlights: [
      { icon: 'i-retry', title: () => t('Gemini model preparation'), text: () => t('Rechecks the exact selected model when closing its menu replaces the header, while preserving the original draft, attachments and preparation deadline.') }
    ]
  },
  '0.6.21': {
    lead: () => t('Finish fresh-chat preparation with the current native control.'),
    highlights: [
      { icon: 'i-retry', title: () => t('Gemini chat preparation'), text: () => t('Handles a Send button replaced during preparation while preserving the original draft and attachments. A dispatched message is never clicked again because its receipt is late.') }
    ]
  },
  '0.6.20': {
    lead: () => t('Keep handoff preparation responsive.'),
    highlights: [
      { icon: 'i-retry', title: () => t('Native model preparation'), text: () => t('Picker readback yields to native rendering and cancellation instead of repeatedly waking itself.') },
      { icon: 'i-chat', title: () => t('Current chat status'), text: () => t('A failed handoff stays in history, while a newly confirmed question clears that old failure from the native composer control.') }
    ]
  },
  '0.6.19': {
    lead: () => t('Keep approvals and queued messages working together.'),
    highlights: [
      { icon: 'i-check-circle', title: () => t('Native tool approvals'), text: () => t('Matches complete tool names to the configured connector and enabled permissions, including tools with spaces in their display names.') },
      { icon: 'i-retry', title: () => t('Steer while tools wait'), text: () => t('A pending approval cannot be mistaken for a failed Stop and trigger immediate tab closure. Exact running requests also protect their page during recovery.') },
      { icon: 'i-terminal', title: () => t('Resumed task receipts'), text: () => t('Restores the original Compact & Resume command receipt after restarting the app.') }
    ]
  },
  '0.6.18': {
    lead: () => t('Keep task progress and connection status separate.'),
    highlights: [
      { icon: 'i-terminal', title: () => t('Long-running tasks'), text: () => t('Running local tools count as progress. A connection notice or silence warning alone no longer ends the current task.') },
      { icon: 'i-retry', title: () => t('Companion delivery'), text: () => t('Restores a missing observer in an already open chat promptly. Native connector chips no longer look like an unsent text draft or prevent Send confirmation.') },
      { icon: 'i-chat', title: () => t('Less chat clutter'), text: () => t('Failed automatic messages disappear after thirty minutes. Use their × button to dismiss them earlier.') }
    ]
  },
  '0.6.17': {
    lead: () => t('Keep long tasks and follow-ups connected.'),
    highlights: [
      { icon: 'i-retry', title: () => t('Reliable Gemini reloads'), text: () => t('Earlier approval replies stay separate from your instructions while chat history loads, so they cannot interrupt a pending Steer or change the current task.') },
      { icon: 'i-terminal', title: () => t('Long tasks and background work'), text: () => t('Includes the resumed-task authorization and background-process fixes from the previous candidates. Steer preserves the original local process and its retained output.') },
      { icon: 'i-retry', title: () => t('Smaller internal updates'), text: () => t('Compatible Windows and Linux installations receive a verified application capsule while keeping their existing profile and saved chats.') }
    ]
  },
  '0.6.16': {
    lead: () => t('Confirm explicit Steer from the native cancellation control.'),
    highlights: [
      { icon: 'i-retry', title: () => t('Native Steer confirmation'), text: () => t('An explicit Steer can confirm the provider has stopped when its exact Stop control changes to the ready voice control. The original local process and poll remain separate.') }
    ]
  },
  '0.6.15': {
    lead: () => t('Confirm Steer when the provider collapses a stopped response.'),
    highlights: [
      { icon: 'i-retry', title: () => t('Steer beside local tools'), text: () => t('Recognizes a newly stopped native response even when its reasoning body has disappeared, while preserving the original local process and poll.') },
      { icon: 'i-chat', title: () => t('Queued follow-ups'), text: () => t('Keeps the current question checks while releasing the same pending message after confirmed native Stop.') }
    ]
  },
  '0.6.14': {
    lead: () => t('Keep ready chats moving while another chat recovers.'),
    highlights: [
      { icon: 'i-retry', title: () => t('Independent chat delivery'), text: () => t('A slow recovery in another chat no longer holds the shared input pickup. The document being repaired keeps its own delivery fence.') },
      { icon: 'i-plugin', title: () => t('Plugin discovery'), text: () => t('An unattributed installed-plugin inventory stays recorded without triggering a conversation reload. Scoped work keeps its existing identity checks.') },
      { icon: 'i-terminal', title: () => t('Process cleanup and long tasks'), text: () => t('Includes the shutdown cleanup and resumed-task authorization repairs from the previous Beta candidates.') }
    ]
  },
  '0.6.13': {
    lead: () => t('Confirm completed process cleanup before updating.'),
    highlights: [
      { icon: 'i-terminal', title: () => t('Concurrent process cleanup'), text: () => t('An update can proceed when completion capture has already proved the same WSL process token gone. Unknown scans, retained tokens and unconfirmed Windows exits still block installation.') },
      { icon: 'i-retry', title: () => t('Long resumed tasks'), text: () => t('Includes the task authorization and Steer repairs from the previous Beta candidates.') }
    ]
  },
  '0.6.12': {
    lead: () => t('Keep long tasks authorized after Compact & Resume.'),
    highlights: [
      { icon: 'i-retry', title: () => t('Long resumed tasks'), text: () => t('Completed handoff receipts survive cleanup and restart, so an ongoing resumed task keeps its local tool access. Replaced questions, stopped responses and changed chat attachments still require fresh task authorization.') },
      { icon: 'i-terminal', title: () => t('Messages alongside local work'), text: () => t('Includes the early Steer and retained follow-up fixes while local tasks and polls continue.') }
    ]
  },
  '0.6.11': {
    lead: () => t('Confirm early Steer without waiting for local work.'),
    highlights: [
      { icon: 'i-retry', title: () => t('Early native Stop'), text: () => t('If the provider stops before an assistant section appears, Steer confirms the exact native question and terminal response while keeping local processes alive.') },
      { icon: 'i-terminal', title: () => t('Follow-ups alongside local work'), text: () => t('Includes the Send and After this turn fixes for local polls, with retained queued messages and unchanged task ownership.') }
    ]
  },
  '0.6.10': {
    lead: () => t('Keep room for messages while local tasks run.'),
    highlights: [
      { icon: 'i-terminal', title: () => t('Messages alongside local work'), text: () => t('Send and After this turn use the confirmed native response boundary while local tasks and polls continue. Accepted messages stay queued while OneCode holds browser pickup.') },
      { icon: 'i-retry', title: () => t('Steer delivery'), text: () => t('Steer keeps its exact native Stop, refresh and Send receipts while preserving local processes. The browser and app use the same live input policy.') }
    ]
  },
  '0.6.9': {
    lead: () => t('Keep room for messages while local tasks run.'),
    highlights: [
      { icon: 'i-terminal', title: () => t('Messages alongside local work'), text: () => t('A confirmed native response boundary can admit your next message while a local task or poll continues. Cached activity no longer holds an eligible message in the browser.') },
      { icon: 'i-retry', title: () => t('Steer delivery'), text: () => t('Steer keeps its exact native Stop, refresh and Send receipts while preserving local processes. The browser and app use the same live input policy.') }
    ]
  },
  '0.6.8': {
    lead: () => t('Wait for Gemini to finish preparing a new chat.'),
    highlights: [
      { icon: 'i-retry', title: () => t('New chat preparation'), text: () => t('Gemini can publish its warm-up question before clearing the editor. OneCode waits for that native cleanup before restoring your task, while preserving changed drafts and cancelled preparation.') }
    ]
  },
  '0.6.7': {
    lead: () => t('Keep the browser responsive when Stable and Beta Companions share a profile.'),
    highlights: [
      { icon: 'i-browser', title: () => t('Companion controls coexist'), text: () => t('Stable and Beta keep their own composer controls and progress panels, preventing repeated removal and reinsertion from freezing a provider page.') },
      { icon: 'i-retry', title: () => t('Recovery and startup improvements'), text: () => t('Includes the earlier Stop/restart, bounded startup and keyring waits, correct Windows/Linux connection routing, recorded file links and centered previews.') }
    ]
  },
  '0.6.6': {
    lead: () => t('Keep Windows and Linux browser connections on the correct host.'),
    highlights: [
      { icon: 'i-browser', title: () => t('Windows and WSL connections stay separate'), text: () => t('The Companion checks the browser and app operating systems before connecting, so a forwarded WSL port cannot silently attach a Windows browser to Linux.') },
      { icon: 'i-retry', title: () => t('Stop and restart the chat'), text: () => t('After the provider confirms Stop, a new message no longer waits on the old activity timer. Recovery checks current work and browser startup has a bounded wait.') },
      { icon: 'i-lock', title: () => t('Open the app when the keyring is waiting'), text: () => t('An unanswered operating-system credential prompt no longer holds startup indefinitely. Saved keys stay intact, and protected operations can retry after the keyring responds.') },
      { icon: 'i-file-text', title: () => t('File links and centered previews'), text: () => t('Recorded file links can use their native download control without enabling model screen or control permissions. Image preview dialogs open centered.') }
    ]
  },
  '0.6.5': {
    lead: () => t('Recovery improvements and a bounded wait for secure credential storage.'),
    highlights: [
      { icon: 'i-lock', title: () => t('Open the app when the keyring is waiting'), text: () => t('An unanswered operating-system credential prompt no longer holds startup indefinitely. Saved keys stay intact, and protected operations can retry after the keyring responds.') },
      { icon: 'i-retry', title: () => t('Stop and restart the chat'), text: () => t('After the provider confirms Stop, a new message no longer waits on the old activity timer. Recovery checks current work and browser startup has a bounded wait.') },
      { icon: 'i-file-text', title: () => t('File links and centered previews'), text: () => t('Recorded file links can use their native download control without enabling model screen or control permissions. Image preview dialogs open centered.') }
    ]
  },
  '0.6.4': {
    lead: () => t('More reliable recovery, Stop and browser startup.'),
    highlights: [
      { icon: 'i-retry', title: () => t('Recovery checks current work'), text: () => t('Page recovery asks for the current tool state instead of waiting on an old busy snapshot after a connection failure.') },
      { icon: 'i-chat', title: () => t('Stop during initial thinking'), text: () => t('An exact native question receipt lets Stop reach a response before its first assistant section appears.') },
      { icon: 'i-browser', title: () => t('Browser startup recovers after idle time'), text: () => t('A completed browser launch cannot suppress later explicit messages forever, and connector startup has a bounded wait.') },
      { icon: 'i-file-text', title: () => t('File links and centered previews'), text: () => t('Recorded file links can use their native download control without enabling model screen or control permissions. Image preview dialogs open centered.') }
    ]
  },
  '0.6.3': {
    lead: () => t('Use OneCode reliably from IDE chat clients such as CLion.'),
    highlights: [
      { icon: 'i-plug', title: () => t('IDE new chats map to new OneCode chats'), text: () => t('A fresh OpenAI-compatible client thread can start the provider selected by its OneCode model instead of inheriting a stale provider-bound API chat.') },
      { icon: 'i-chat', title: () => t('Slash controls work inside IDE chat'), text: () => t('/new and /provider can be sent as ordinary OpenAI chat messages when the client cannot call OneCode-specific HTTP control routes directly.') },
      { icon: 'i-file-text', title: () => t('IDE context without chat bloat'), text: () => t('Current project/file context is preserved while JetBrains helper calls stay local and old assistant/tool transcript is not duplicated into every durable OneCode turn.') },
      { icon: 'i-terminal', title: () => t('Approved IDE projects edit directly'), text: () => t('When the IDE project is already approved in OneCode, its API chat binds to that workspace so OneCode can read, patch and run project files directly instead of driving the editor by mouse.') },
      { icon: 'i-retry', title: () => t('API waits for the recorded final correctly'), text: () => t('Gemini completion waits resolve through OneCode’s response-turn chronology instead of waiting forever after the exact final has already been recorded.') }
    ]
  },
  '0.6.2': {
    lead: () => t('Use the OneCode agent from IDEs and local OpenAI-compatible clients.'),
    highlights: [
      { icon: 'i-plug', title: () => t('OneCode API (Beta)'), text: () => t('Turn on a local OpenAI-compatible endpoint in Settings, then copy its loopback URL and encrypted per-device key into an IDE or other client.') },
      { icon: 'i-chat', title: () => t('API calls control real OneCode chats'), text: () => t('/new opens a durable OneCode chat, /provider chooses ChatGPT or Gemini for new chats, and completions use the same provider and durable Send path as the desktop.') },
      { icon: 'i-skill', title: () => t('Skills and plugins stay live'), text: () => t('Capability discovery reads the current Core tools, permissions, skills and installed plugins so newly enabled abilities appear without restarting the API.') },
      { icon: 'i-lock', title: () => t('Local, persistent and opt-in'), text: () => t('The listener is off by default and loopback-only. Its bearer key stays in encrypted OS storage, survives compatible updates and can be rotated from the trusted desktop.') }
    ]
  },
  '0.6.0': {
    lead: () => t('Recoverable history access, installation-local Windows data, and faster Remote and Linux updates.'),
    highlights: [
      { icon: 'i-file-text', title: () => t('History and task access recover together'), text: () => t('A temporarily inaccessible journal retains its history and task grant. Windows copies and verifies default profile data beside the installation on a normal launch, preserving the original backup.') },
      { icon: 'i-bolt', title: () => t('Readiness follows the live browser'), text: () => t('Setup distinguishes saved sign-in from a live connection, remembers each provider separately, and opens the selected provider to reconnect. Busy connections no longer delay every desktop state update.') },
      { icon: 'i-bolt', title: () => t('Remote opens without repeated route checks'), text: () => t('Remote reuses a recent verified private route and its first bootstrap instead of blocking each read on repeated Tailscale CLI checks. Background route verification still suspends access if custody changes.') },
      { icon: 'i-terminal', title: () => t('Linux downloads show progress'), text: () => t('AppImage downloads report transport progress while SHA-256 remains the authority for accepting the completed update. Hotfix and combined update progress continue to use their published sizes.') },
      { icon: 'i-file-text', title: () => t('Natural Linux text spacing'), text: () => t('Linux prefers the system UI font before CJK fallbacks so Latin punctuation and apostrophes keep normal spacing without rewriting message text.') }
    ]
  },
  '0.5.10': {
    lead: () => t('More reliable long chats, visible background work, and verified updates on Windows and Linux.'),
    highlights: [
      { icon: 'i-terminal', title: () => t('Recover completed terminal results'), text: () => t('Completed output releases its live slot, remains recoverable after restart, and no longer blocks new work after delivery.') },
      { icon: 'i-retry', title: () => t('Recovery keeps the original task'), text: () => t('Opening a chat loads its exact browser tab. Continue and Compact & Resume retain their original intent while the page becomes ready, without resending an uncertain message.') }
    ]
  },
  '0.5.9': {
    lead: () => t('Terminal recovery, reliable Stop, and folder access in existing chats.'),
    highlights: [
      { icon: 'i-terminal', title: () => t('Recover completed terminal results'), text: () => t('Completed output releases its live slot, remains recoverable after restart, and no longer blocks new work after delivery.') },
      { icon: 'i-retry', title: () => t('Stop and reuse workers'), text: () => t('Stop waits for the provider’s confirmed boundary. Sleeping workers remain reusable after a chat handoff, and pending terminal launches are cancelled during shutdown.') },
      { icon: 'i-folder', title: () => t('Folder access without a new chat'), text: () => t('Shared folders apply to existing chats immediately. A standalone written folder approval in the app uses the same folder-grant owner.') },
      { icon: 'i-image', title: () => t('Easier Remote conversations'), text: () => t('Scroll upward to load earlier history, preview image attachments, and find workers beneath their parent chat.') }
    ]
  },
  '0.5.5': {
    lead: () => t('More reliable long chats, visible background work, and verified updates on Windows and Linux.'),
    highlights: [
      { icon: 'i-terminal', title: () => t('Find and stop background work'), text: () => t('Inspect commands from every chat and stop an individual process. Explicit chat Stop also cancels that chat’s owned commands while preserving their output.') },
      { icon: 'i-retry', title: () => t('Recovery keeps the original task'), text: () => t('Opening a chat loads its exact browser tab. Continue and Compact & Resume retain their original intent while the page becomes ready, without resending an uncertain message.') },
      { icon: 'i-lock', title: () => t('Task access survives a restart'), text: () => t('Valid task and device authorization stays tied to its original owner across restarts. Completed output is retained independently of live terminal capacity.') },
      { icon: 'i-bolt', title: () => t('One update, one restart'), text: () => t('Windows and Linux AppImage updates can stage a required complete base and its application hotfix together. Update now stops owned work before restarting.') },
      { icon: 'i-browser', title: () => t('A separate Beta installation'), text: () => t('Beta has its own installation, profile and update channel so release and hotfix acceptance can run alongside your normal workspace.') }
    ]
  },
  '0.5.1': {
    lead: () => t('More reliable long chats, visible background work, and verified updates on Windows and Linux.'),
    highlights: [
      { icon: 'i-terminal', title: () => t('Find and stop background work'), text: () => t('Inspect commands from every chat and stop an individual process. Explicit chat Stop also cancels that chat’s owned commands while preserving their output.') },
      { icon: 'i-retry', title: () => t('Recovery keeps the original task'), text: () => t('Opening a chat loads its exact browser tab. Continue and Compact & Resume retain their original intent while the page becomes ready, without resending an uncertain message.') },
      { icon: 'i-lock', title: () => t('Task access survives a restart'), text: () => t('Valid task and device authorization stays tied to its original owner across restarts. Completed output is retained independently of live terminal capacity.') },
      { icon: 'i-bolt', title: () => t('One update, one restart'), text: () => t('Windows and Linux AppImage updates can stage a required complete base and its application hotfix together. Update now stops owned work before restarting.') },
      { icon: 'i-browser', title: () => t('A separate Beta installation'), text: () => t('Beta has its own installation, profile and update channel so release and hotfix acceptance can run alongside your normal workspace.') }
    ]
  },
  '0.5.0': {
    lead: () => t('OneCode now ships as a full Windows and Linux release, with verified hotfix foundations on both platforms.'),
    highlights: [
      { icon: 'i-sparkle', title: () => t('Linux joins the release'), text: () => t('Linux x64 ships as AppImage and DEB with the same chats, Core connector, Companion and local-tool workflow. AppImage installs can take future verified application hotfixes without replacing the native runtime.') },
      { icon: 'i-lock', title: () => t('Authorization stays with the exact task'), text: () => t('Fresh OneCode task authorization keeps plans, plugins and sub-agents inside the authenticated Core execution path instead of dropping them into Unattributed activity.') },
      { icon: 'i-image', title: () => t('Preview an image before sending'), text: () => t('Click an attached image in the composer to inspect the staged photo at useful resolution before you send it.') },
      { icon: 'i-browser', title: () => t('Steadier Linux browser and connection behavior'), text: () => t('The embedded browser follows Linux zoom and dock motion, selected web links use your configured browser, and established connectors stay published through transient public-health misses.') }
    ]
  },
  '0.4.8': {
    lead: () => t('Continue stops the unfinished response, and long tool calls keep their connection active.'),
    highlights: [
      { icon: 'i-check-circle', title: () => t('Continue stops the exact unfinished turn'), text: () => t('An immediate follow-up retains its Stop target after the activity display expires. It waits for the provider to confirm the end before sending your message.') },
      { icon: 'i-retry', title: () => t('Keep long tool responses connected'), text: () => t('Long tool calls stream keepalive comments through the connector, including modern clients, while waiting for the result.') },
      { icon: 'i-lock', title: () => t('Interrupted calls are never replayed'), text: () => t('An interrupted proxy stream closes as a failure. OneCode records premature response closure for diagnosis and does not automatically repeat the operation.') }
    ]
  },
  '0.4.7': {
    lead: () => t('Steering keeps the replacement turn working and recovery watching.'),
    highlights: [
      { icon: 'i-check-circle', title: () => t('Steer without losing the working turn'), text: () => t('A correction sent after Stop keeps its exact acknowledgement even when the previous message is temporarily unreadable. The new turn regains working state and tool access.') },
      { icon: 'i-retry', title: () => t('Recovery after 90 seconds without progress'), text: () => t('Normal recovery watches the current turn for 90 seconds. A confirmed ChatGPT message can receive one guarded refresh before its first tool call, too.') },
      { icon: 'i-lock', title: () => t('Progress and your controls take priority'), text: () => t('New progress, another question, Stop, approvals and running tools prevent an obsolete refresh. Recovery does not resend your steering message.') }
    ]
  },
  '0.4.6': {
    lead: () => t('Keep tool access when a handoff message is still rendering.'),
    highlights: [
      { icon: 'i-check-circle', title: () => t('Handoff authorization recovery'), text: () => t('An acknowledged message starts its turn even when its browser bubble is temporarily unreadable, so local tools can use its fresh authorization.') },
      { icon: 'i-lock', title: () => t('Existing authorization checks stay in place'), text: () => t('Recovery keeps the exact chat and accepted message. It does not resend your task or reuse an older authorization.') },
      { icon: 'i-sparkle', title: () => t('Small application hotfix'), text: () => t('Install through Settings → General → Check for updates, then Install when done. Your chats and settings stay in place.') }
    ]
  },
  '0.4.5': {
    lead: () => t('Clear download progress and complete updates in one restart.'),
    highlights: [
      { icon: 'i-check-circle', title: () => t('Hotfix download progress'), text: () => t('The download percentage follows the bytes received and reaches 100% only after verification and staging.') },
      { icon: 'i-steps', title: () => t('One update, one restart'), text: () => t('If a hotfix needs a newer full release, OneCode downloads both, installs the base first and applies the hotfix before reopening.') },
      { icon: 'i-lock', title: () => t('The exact release you selected'), text: () => t('Installer downloads stay on their selected release even when a newer hotfix is published during the download.') },
      { icon: 'i-sparkle', title: () => t('Earlier fixes stay included'), text: () => t('Full releases include earlier hotfixes, including connection repairs and the What’s new pane. Your chats and settings are preserved.') }
    ]
  },
  '0.4.4': {
    lead: () => t('See what changed after an update, including small hotfixes.'),
    highlights: [
      { icon: 'i-sparkle', title: () => t('Update highlights are back'), text: () => t('This summary opens once after updating. If another dialog is open, it waits until you close it.') },
      { icon: 'i-gear', title: () => t('Review changes anytime'), text: () => t('Open Settings → General → What’s new to see the changes in your installed version again.') },
      { icon: 'i-check-circle', title: () => t('Smaller hotfix updates'), text: () => t('Compatible hotfixes download a smaller application bundle and activate through Install when done. Your chats and settings stay in place.') },
      { icon: 'i-globe', title: () => t('Connection fixes included'), text: () => t('Public checks allow slow valid replies. A timeout is reported separately from a TLS failure.') }
    ]
  },
  '0.4.3': {
    lead: () => t('More patient connection checks and smaller future updates.'),
    highlights: [
      { icon: 'i-globe', title: () => t('Time for a valid reply'), text: () => t('Public checks allow slow valid replies. A timeout is reported separately from a TLS failure.') },
      { icon: 'i-check-circle', title: () => t('Smaller hotfix updates'), text: () => t('Compatible hotfixes download a smaller application bundle and activate through Install when done. Your chats and settings stay in place.') }
    ]
  },
  '0.3.0': {
    lead: () => t('Provider setup, parallel chats and clearer controls.'),
    highlights: [
      { icon: 'i-check-circle', title: () => t('Account sign-in'), text: () => t('The companion recognizes the selected provider’s existing browser account.') },
      { icon: 'i-bolt', title: () => t('Independent chats'), text: () => t('Each chat keeps its provider and model list while other providers work in parallel.') },
      { icon: 'i-check-circle', title: () => t('Feedback questions'), text: () => t('Recognized response-comparison questions are dismissed through their own footer. Thinking controls stay untouched.') },
      { icon: 'i-terminal', title: () => t('Device connector names'), text: () => t('Configured names are published exactly, with unique native presentation matching.') }
    ]
  },
  '2.1.37': {
    lead: () => t('Find in chat, slash commands, and messages that go where you want.'),
    highlights: [
      { icon: 'i-search', title: () => t('Find in chat'), text: () => t('{0} searches the whole chat, older messages included.', [primaryShortcut('F')]) },
      { icon: 'i-terminal', title: () => t('Slash commands'), text: () => t('Type / in the message box to pick a model, rename or pin the chat, see its status and more.') },
      { icon: 'i-bolt', title: () => t('Send now'), text: () => t('A queued message can join the running answer right away, and you choose what Enter does.') },
      { icon: 'i-check-circle', title: () => t('Told when a chat finishes'), text: () => t('A notification when a chat is done while the app is in the background, and the computer stays awake while it works.') },
      { icon: 'i-agents', title: () => t('Worker chats out of the way'), text: () => providerText('Turn it on, and worker chats are archived in Gemini once the app is done with them.') }
    ]
  },
  '2.1.36': {
    lead: () => providerText('Steadier long runs, a tunnel that works behind a proxy, and Gemini\'s own words.'),
    highlights: [
      { icon: 'i-retry', title: () => t('Steadier long runs'), text: () => t('Chats recover more reliably, also after your computer sleeps, and the timeline keeps a long turn in order.') },
      { icon: 'i-globe', title: () => t('Works behind a proxy'), text: () => providerText('The tunnel to Gemini uses your system\'s proxy by itself.') },
      { icon: 'i-chat', title: () => t('Better dictation on Windows'), text: () => t('Dictation uses Windows\' own speech recognition, with punctuation and much better accuracy.') },
      { icon: 'i-plug', title: () => providerText('Plugins, as Gemini calls them'), text: () => providerText('The app now says plugin, like Gemini, and plugins with many tools can be installed.') },
      { icon: 'i-terminal', title: () => t('Start chats from your own tools'), text: () => t('The Local control API can start a new chat and send its events as they happen.') }
    ]
  },
  '2.1.35': {
    lead: () => providerText('Gemini Projects for your projects, workers in their own Git copy, and steadier long runs.'),
    highlights: [
      { icon: 'i-folder', title: () => providerText('Projects in Gemini'), text: () => providerText('New projects get their own Gemini Project, and their new chats open inside it.') },
      { icon: 'i-browser', title: () => t('Background chats in a tab group'), text: () => t('Background chats can stay in one collapsed tab group in your browser window instead of their own window.') },
      { icon: 'i-git-diff', title: () => t('Workers in their own Git copy'), text: () => t('When you turn it on, each new worker gets its own Git worktree and branch, away from your checkout.') },
      { icon: 'i-chat', title: () => t('Dictation on Windows'), text: () => t('The microphone button turns your speech into text in the message box, and you send it when you\'re ready.') },
      { icon: 'i-plug', title: () => t('Rename your plugins'), text: () => providerText('OneCode apps you rename in Gemini keep working.') }
    ]
  },
  '2.1.34': {
    lead: () => t('Goal on every plan, Compact & Resume in Projects, and a background window that stays.'),
    highlights: [
      { icon: 'i-target', title: () => t('Goal on every plan'), text: () => t('On plans without a model picker, such as Free, Goal and Loop follow-ups use the chat\'s current model instead of failing.') },
      { icon: 'i-steps', title: () => t('Compact & Resume in Projects'), text: () => providerText('Moving a chat inside a Gemini Project to a new chat now completes, and the new chat stays in that Project.') },
      { icon: 'i-browser', title: () => t('A background window that stays'), text: () => t('Background chats keep using the same window after the extension updates or reloads.') },
      { icon: 'i-plug', title: () => t('Clearer plugin hints'), text: () => providerText('When Gemini calls a tool its plugin doesn\'t have, the result names the plugin that has it.') },
      { icon: 'i-terminal', title: () => t('Fewer repeated commands'), text: () => providerText('When Gemini starts a command that is still running in that chat, the result points it to the running one.') }
    ]
  },
  '2.1.33': {
    lead: () => t('Reuse a saved summary, see why a message waits, and a background window that follows you.'),
    highlights: [
      { icon: 'i-steps', title: () => t('Reuse a saved summary'), text: () => providerText('If Compact & Resume stops after Gemini wrote its summary, open the new chat with that summary instead of starting over.') },
      { icon: 'i-clock', title: () => t('See why a message waits'), text: () => t('A queued message says when it is waiting for the browser extension or for a running tool call.') },
      { icon: 'i-browser', title: () => t('The background window follows you'), text: () => t('With Background chats on, the chat you select in the app is the one its background window shows.') },
      { icon: 'i-retry', title: () => providerText('Calmer when Gemini is busy'), text: () => providerText('When Gemini limits how fast history loads, recovery waits as long as Gemini asks instead of reloading again.') },
      { icon: 'i-bolt', title: () => t('Lighter on your computer'), text: () => providerText('Open Gemini chats use much less CPU while they wait.') }
    ]
  },
  '2.1.32': {
    lead: () => providerText('Messages that reach the running answer, the choices Gemini asks you about, and a Stop that sticks.'),
    highlights: [
      { icon: 'i-bolt', title: () => t('Messages reach the running answer'), text: () => providerText('Send directly puts your message into the running answer as a real Gemini message, even while a command runs, and the command keeps its result.') },
      { icon: 'i-check-circle', title: () => providerText("Gemini's choices in the timeline"), text: () => providerText('When Gemini asks you to pick an option, the timeline shows the question and its choices.') },
      { icon: 'i-ban', title: () => t('A Stop that sticks'), text: () => t('Stop ends the turn even when a late tool result reopens it, and the timeline says when it stopped.') },
      { icon: 'i-chart', title: () => t('A clearer Usage page'), text: () => t('Whole token counts, a lower bound for costs without a price, and the newest weeks of activity first.') },
      { icon: 'i-skill', title: () => t('Skills in your language'), text: () => t('The recommended skills describe themselves in the language of the app.') }
    ]
  },
  '2.1.31': {
    lead: () => providerText('GPT-6 support, a timeline that reads like Gemini, and a clearer view of your sub-agents.'),
    highlights: [
      { icon: 'i-sparkle', title: () => t('Ready for GPT-6'), text: () => t('Pick GPT-6, GPT-5.6 or GPT-5.5 with Instant, Medium or High. Goal, Loop and Compact & Resume work on GPT-6.') },
      { icon: 'i-steps', title: () => t('A timeline in rounds'), text: () => providerText("Each turn reads in rounds like Gemini's own, with the model's notes between steps, a live status line and formulas.") },
      { icon: 'i-agents', title: () => t('A clearer sub-agent list'), text: () => t('Each worker is named for its job and shows its task, its state and its model.') },
      { icon: 'i-lock', title: () => providerText('Setup asks what Gemini may do'), text: () => t('The same permission switches as in Workspace, and Setup tells you when access is limited.') },
      { icon: 'i-panel-right', title: () => t('Panels in the title bar'), text: () => t('The panel buttons moved to the title bar, and the right panel now runs the full height of the window.') }
    ]
  },
  '2.1.30': {
    lead: () => t('See what changed after each update, and long runs that stop and recover more calmly.'),
    highlights: [
      { icon: 'i-sparkle', title: () => t("What's new, after every update"), text: () => t('A short summary like this one shows once after each update, with a link to the full notes.') },
      { icon: 'i-retry', title: () => t('Clear stops for stuck messages'), text: () => providerText('If Gemini never picks up a queued message, the app tries three times, then tells you and keeps it queued.') },
      { icon: 'i-agents', title: () => t('Steadier sub-agents'), text: () => t('New worker tabs get more time on slow connections, and a worker no longer gets stuck behind its own unsent message.') },
      { icon: 'i-gear', title: () => t('Your settings stay put'), text: () => t("A settings file the app can't read no longer resets everything: the app reads it anyway or keeps a copy.") },
      { icon: 'i-loop', title: () => t('Recovery stays on'), text: () => t("When the app reuses a quiet chat's tab for a new chat, that chat keeps its automatic recovery.") }
    ]
  },
  '2.1.29': {
    lead: () => providerText('Pin your chats, search from anywhere, and know when Gemini is waiting for you.'),
    highlights: [
      { icon: 'i-pin', title: () => t('Pin chats'), text: () => t('Keep the chats you use most at the top of the sidebar.') },
      { icon: 'i-more', title: () => t('One menu for every chat'), text: () => t("Pin, rename, open or copy a chat's link from its ⋯ menu.") },
      { icon: 'i-search', title: () => t('Search from anywhere'), text: () => t('{0} finds any chat and opens it at the message that matched.', [primaryShortcut('K')]) },
      { icon: 'i-gear', title: () => t('Search your settings'), text: () => t('Type in Settings to find any setting on any page.') },
      { icon: 'i-lock', title: () => providerText('Know when Gemini is waiting'), text: () => providerText('When Gemini asks you to allow a tool, the chat tells you instead of standing still.') },
      { icon: 'i-plug', title: () => t('One connection control'), text: () => t('A small capsule in the sidebar shows the connection and tells you if it drops.') }
    ]
  }
};

export function hasHighlights(version: string): boolean {
  return Object.hasOwn(RELEASES, version);
}

/** Paints the dialog for one version; separate from showing it so a check can paint any entry. */
export function paintWhatsNew(version: string): boolean {
  const release = RELEASES[version];
  if (!release) return false;
  ui($('whatsNewVersion'), 'textContent', () => t('Version {0}', [channelVersion(version)]));
  ui($('whatsNewLead'), 'textContent', release.lead);
  $('whatsNewList').replaceChildren(...release.highlights.map((item, index) => {
    const row = el('li', 'whats-new-item');
    // The rows arrive one after another, after the card and its tile.
    row.style.setProperty('--i', String(index));
    const badge = el('span', 'whats-new-icon');
    badge.append(icon(item.icon));
    const words = el('div', 'whats-new-words');
    words.append(el('b', '', item.title), el('span', '', item.text));
    row.append(badge, words);
    return row;
  }));
  $<HTMLButtonElement>('whatsNewNotes').dataset.version = version;
  return true;
}

/**
 * Centred in a window of odd width or height, the dialog starts half a pixel off the pixel grid
 * and every icon in it blurs and drifts by that half pixel. Its own size is whole pixels, so
 * whole-pixel margins keep it centred within half a pixel and crisp. Margins, not a transform:
 * a fractional transform rasterises the glyphs off the grid all the same.
 */
function snapToPixels(dialog: HTMLDialogElement): void {
  if (!dialog.open) return;
  const x = (window.innerWidth - dialog.offsetWidth) / 2;
  const y = (window.innerHeight - dialog.offsetHeight) / 2;
  dialog.style.margin = x < 0 || y < 0 ? '' : `${Math.floor(y)}px ${Math.ceil(x)}px ${Math.ceil(y)}px ${Math.floor(x)}px`;
}

let wired = false;
let cancelPending: (() => void) | undefined;
function wire(dialog: HTMLDialogElement): void {
  if (wired) return;
  wired = true;
  window.addEventListener('resize', () => snapToPixels(dialog));
  const close = (): void => {
    if (!dialog.open || dialog.classList.contains('is-closing')) return;
    dialog.classList.add('is-closing');
    const done = (): void => { dialog.classList.remove('is-closing'); if (dialog.open) dialog.close(); };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) done();
    else { dialog.addEventListener('animationend', done, { once: true }); window.setTimeout(done, 280); }
  };
  $('whatsNewDone').addEventListener('click', close);
  $('whatsNewNotes').addEventListener('click', () => {
    const version = $<HTMLButtonElement>('whatsNewNotes').dataset.version;
    if (version) void run(window.api.openLink(releaseNotesUrl(version), { external: true }));
  });
  // Escape and a click on the backdrop dismiss it like the button does, with the same motion.
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
}

/** The same installed-version summary is available from Settings after dismissal. */
export function showWhatsNew(version: string): boolean {
  const dialog = $<HTMLDialogElement>('whatsNewDialog');
  if (document.querySelector('dialog[open]') || !paintWhatsNew(version)) return false;
  cancelPending?.();
  wire(dialog);
  dialog.showModal();
  snapToPixels(dialog);
  $('whatsNewDone').focus({ focusVisible: false } as FocusOptions);
  void run(window.api.markWhatsNewSeen());
  return true;
}

/**
 * Decides once per start: shows the dialog after a real update to a version with highlights and
 * records the version once it has been shown, so it never shows twice; any other version change is
 * recorded at once. A fresh install has already recorded
 * its version in the main process, before anything here runs.
 */
export function initWhatsNew(current: string | null, lastSeen: string | undefined): void {
  cancelPending?.();
  if (!current) return;
  const action = whatsNewAction(current, lastSeen, hasHighlights);
  if (action === 'none') return;
  if (action !== 'show' || !paintWhatsNew(current)) { void run(window.api.markWhatsNewSeen()); return; }
  // After the window has painted its first state, so the dialog opens over a settled app. Another
  // open dialog wins; its close event resumes this pending summary without another restart.
  let settled = false;
  const attempt = (): void => { if (settled) showWhatsNew(current); };
  const timer = window.setTimeout(() => { settled = true; attempt(); }, 600);
  const cancel = (): void => {
    window.clearTimeout(timer);
    document.removeEventListener('close', attempt, true);
    window.removeEventListener('pagehide', cancel);
    if (cancelPending === cancel) cancelPending = undefined;
  };
  cancelPending = cancel;
  document.addEventListener('close', attempt, true);
  window.addEventListener('pagehide', cancel, { once: true });
}
