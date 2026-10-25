/** One browser startup owner for explicit work and durable recovery. */
import { bridgeStatus, browserWakeConnected } from './bridge.js';
import { isPreferredBrowserRunning, openInPreferredBrowser } from './browser.js';
import { getConfig } from './config.js';
import { wakeBrowserWork } from './browser-wake.js';

let waking: { lastSeenAt: number | null; selected: string; work: Promise<void>; failed: boolean; finished: boolean; finishedAt: number | null } | null = null;
const AUTHORED_WAKE_COOLDOWN_MS = 30_000;
/** One browser startup per absence episode, shared by authored sends, discovery and owed recovery. */
export async function wakeBrowserUrl(url: string, retry = false, backgroundStartup = false,
  authority?: { current(): boolean | Promise<boolean>; authoredInput?: true }): Promise<void> {
  if (authority && !await authority.current()) return;
  const browser = await bridgeStatus();
  if (browserWakeConnected()) { waking = null; wakeBrowserWork(); return; }
  const selected = getConfig().ui.chatBrowser ?? 'chrome';
  // The companion can be missing because its protocol is incompatible or MV3 is
  // suspended. Recovery/discovery require process absence. An explicit queued
  // Send may also wake an existing process whose companion cannot hear the work.
  const prior = waking;
  const absent = await isPreferredBrowserRunning() === false;
  // The process query yields. Off, a collected reply or a new navigation can revoke
  // the exact recovery meanwhile; a missing socket alone never proves Chrome exited.
  if (authority && !await authority.current()) return;
  // Both the process probe and durable recovery validation may yield.
  if (selected !== (getConfig().ui.chatBrowser ?? 'chrome')) return;
  if (browserWakeConnected()) { waking = null; wakeBrowserWork(); return; }
  if (!absent && !authority?.authoredInput) return;
  if (retry && waking === prior && (waking?.failed || waking?.finished)) waking = null;
  // A successful OS launch is not Companion readiness. Share concurrent sends,
  // but do not let an unanswered startup suppress every later explicit Send for
  // the lifetime of the app (including overnight). This only opens a queued input's
  // native page; its durable claim/authorization still owns the sole actual Send.
  if (authority?.authoredInput && waking === prior && waking?.finished && !waking.failed &&
      waking.finishedAt !== null && Date.now() - waking.finishedAt >= AUTHORED_WAKE_COOLDOWN_MS) waking = null;
  // Until the extension registers, another explicit send belongs to the same startup.
  // A changed browser choice starts a distinct attempt without adopting the old family.
  if (waking?.lastSeenAt === browser.lastSeenAt && waking.selected === selected) return waking.work;
  const work = (async () => {
    await (backgroundStartup ? openInPreferredBrowser(url, { backgroundStartup: true }) : openInPreferredBrowser(url));
  })();
  const attempt = { lastSeenAt: browser.lastSeenAt, selected, work, failed: false, finished: false, finishedAt: null as number | null };
  waking = attempt;
  try { await work; } catch (error) { attempt.failed = true; throw error; } finally { attempt.finished = true; attempt.finishedAt = Date.now(); }
}
export function resetBrowserStartupForTests(): void { waking = null; }
