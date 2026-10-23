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
  '0.5.4': {
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
