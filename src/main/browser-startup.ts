/** One browser startup owner for explicit work and durable recovery. */
import { randomUUID } from 'node:crypto';
import { bridgeStatus, browserWakeConnected, revealChatInBrowser, startBridge } from './bridge.js';
import { isPreferredBrowserRunning, openInPreferredBrowser } from './browser.js';
import { getConfig } from './config.js';
import { wakeBrowserWork } from './browser-wake.js';

let waking: { lastSeenAt: number | null; selected: string; target: string; foreground: boolean; work: Promise<void>; failed: boolean; finished: boolean; finishedAt: number | null } | null = null;
const AUTHORED_WAKE_COOLDOWN_MS = 30_000;
type WakeAuthority = { current(): boolean | Promise<boolean>; authoredInput?: true };
type WindowLaunch = { port: number; nonce: string; selected: string; target: string; foreground: boolean; expiresAt: number; authority?: WakeAuthority };
let windowLaunch: WindowLaunch | null = null;

export function pendingBrowserWindowLaunch(port: number | null): string | null {
  const launch = windowLaunch;
  if (!launch || launch.port !== port || Date.now() >= launch.expiresAt ||
      launch.selected !== (getConfig().ui.chatBrowser ?? 'chrome')) return null;
  return `http://127.0.0.1:${launch.port}/browser-window?launch=${launch.nonce}`;
}

export async function claimBrowserWindowLaunch(port: number | null, nonce: unknown): Promise<{ url: string; foreground: boolean } | null> {
  const launch = windowLaunch;
  if (!launch || launch.nonce !== nonce || !pendingBrowserWindowLaunch(port) ||
      (launch.authority && !await launch.authority.current()) ||
      windowLaunch !== launch || !pendingBrowserWindowLaunch(port)) return null;
  windowLaunch = null;
  return { url: launch.target, foreground: launch.foreground };
}

/** Explicit desktop access uses the same window as authored inputs and workers. */
export async function openManagedConversation(conversationId: string, url: string): Promise<void> {
  if (getConfig().ui.chatBrowser === 'cos') {
    await openInPreferredBrowser(url, { reveal: true });
    return;
  }
  if (await revealChatInBrowser(conversationId)) return;
  if (!await startBridge()) throw new Error('The browser bridge could not start.');
  if (await wakeBrowserWindow(url, false, true, { current: () => true, authoredInput: true }, true)) return;
  if (!await revealChatInBrowser(conversationId, true))
    throw new Error('The Companion could not open this chat. Check the browser connection in Setup and try again.');
}

/** One browser startup per absence episode, shared by authored sends, discovery and owed recovery. */
export async function wakeBrowserUrl(url: string, retry = false, backgroundStartup = false,
  authority?: WakeAuthority): Promise<void> {
  await wakeBrowserWindow(url, retry, backgroundStartup, authority);
}
async function wakeBrowserWindow(url: string, retry: boolean, backgroundStartup: boolean, authority?: WakeAuthority, foreground = false): Promise<boolean> {
  if (authority && !await authority.current()) return false;
  const browser = await bridgeStatus();
  if (browserWakeConnected()) { waking = null; wakeBrowserWork(); return false; }
  const selected = getConfig().ui.chatBrowser ?? 'chrome';
  // The companion can be missing because its protocol is incompatible or MV3 is
  // suspended. Recovery/discovery require process absence. An explicit queued
  // Send may also wake an existing process whose companion cannot hear the work.
  const prior = waking;
  const absent = await isPreferredBrowserRunning() === false;
  // The process query yields. Off, a collected reply or a new navigation can revoke
  // the exact recovery meanwhile; a missing socket alone never proves Chrome exited.
  if (authority && !await authority.current()) return false;
  // Both the process probe and durable recovery validation may yield.
  if (selected !== (getConfig().ui.chatBrowser ?? 'chrome')) return false;
  if (browserWakeConnected()) { waking = null; wakeBrowserWork(); return false; }
  if (!absent && !authority?.authoredInput) return false;
  if (waking?.selected === selected && pendingBrowserWindowLaunch(browser.port)) {
    const existing = waking;
    await existing.work;
    return existing.target === url && (!foreground || existing.foreground);
  }
  if (retry && waking === prior && (waking?.failed || waking?.finished)) waking = null;
  // A successful OS launch is not Companion readiness. Share concurrent sends,
  // but do not let an unanswered startup suppress every later explicit Send for
  // the lifetime of the app (including overnight). This only opens a queued input's
  // native page; its durable claim/authorization still owns the sole actual Send.
  if (authority?.authoredInput && waking === prior && waking?.finished && !waking.failed &&
      waking.finishedAt !== null && Date.now() - waking.finishedAt >= AUTHORED_WAKE_COOLDOWN_MS) waking = null;
  // Until the extension registers, another explicit send belongs to the same startup.
  // A changed browser choice starts a distinct attempt without adopting the old family.
  if (waking?.lastSeenAt === browser.lastSeenAt && waking.selected === selected) {
    const existing = waking;
    await existing.work;
    return existing.target === url && (!foreground || existing.foreground);
  }
  const launch = selected !== 'cos' && browser.port ? {
    port: browser.port, nonce: randomUUID(), target: url, selected, foreground,
    expiresAt: Date.now() + 60_000, authority
  } : null;
  if (launch) windowLaunch = launch;
  const destination = launch ? pendingBrowserWindowLaunch(launch.port)! : url;
  const work = (async () => {
    if (launch || backgroundStartup) await openInPreferredBrowser(destination, { backgroundStartup: true });
    else if (authority?.authoredInput) await openInPreferredBrowser(destination, { separateWindow: true });
    else await openInPreferredBrowser(destination);
  })();
  const attempt = { lastSeenAt: browser.lastSeenAt, selected, target: url, foreground, work, failed: false, finished: false, finishedAt: null as number | null };
  waking = attempt;
  try { await work; return true; }
  catch (error) { attempt.failed = true; if (windowLaunch === launch) windowLaunch = null; throw error; }
  finally { attempt.finished = true; attempt.finishedAt = Date.now(); }
}
export function resetBrowserStartupForTests(): void { waking = null; windowLaunch = null; }
