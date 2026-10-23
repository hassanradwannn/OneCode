/** Explicit desktop sends bring up the existing connection/browser authorities. */
import { connect, getStatus, onStatusChange } from '../connection.js';
import { startBridge } from '../bridge.js';
import { wakeBrowserUrl, resetBrowserStartupForTests } from '../browser-startup.js';
import { getConfig } from '../config.js';
import { DEFAULT_CHAT_PROVIDER, chatProviderConversationUrl, chatProviderForConversation, chatProviderHomeUrl } from '../../shared/chat-provider.js';
import { enqueueInput, cancelInput, listInputs, noteInputStartupError, releaseSteeringInput, sendQueuedInputNow, type InputArgs, type InputEntry } from './input.js';
import { getSession } from './store.js';
import type { QueuedInputNowIntent } from '../../shared/input.js';

function wakeBrowser(entry: InputEntry, retry = false, signal?: AbortSignal): Promise<void> {
  const marker = `cos-input=${encodeURIComponent(entry.id)}`;
  const provider = chatProviderForConversation(entry.conversationId, entry.chatProvider ?? getConfig().ui.chatProvider ?? DEFAULT_CHAT_PROVIDER);
  const home = chatProviderHomeUrl(provider);
  return wakeBrowserUrl(entry.conversationId ? chatProviderConversationUrl(provider, entry.conversationId)
    : `${home}${home.includes('?') ? '&' : '?'}${marker}#${marker}`, retry, getConfig().ui.backgroundChats === true, {
      ...((entry.authoredSource ?? 'text') === 'text' && (!entry.purpose || entry.purpose === 'user') && !entry.recovery ? { authoredInput: true as const } : {}),
      current: async () => {
        if (stopped || signal?.aborted) return false;
        const current = (await listInputs()).find(row => row.id === entry.id);
        return !stopped && !signal?.aborted && current?.state === 'queued' &&
          current.sendAuthorizedAt === undefined && current.deliveredAt === undefined;
      }
    });
}
/**
 * Connection setup, not the browser, stopped this send (#882 VM test, 2026-10-04: a fresh install
 * said "Browser startup failed: Add a folder before connecting"). Its own prefix says what to do;
 * retry accepts both, so the message still goes out once Setup is done.
 */
const SETUP_PREFIX = 'Message queued. Finish Setup to send: ';
const BROWSER_PREFIX = 'Message queued. Browser startup failed: ';
class SetupNotReady extends Error {}
const startupError = (error: unknown): string =>
  (error instanceof SetupNotReady ? SETUP_PREFIX : BROWSER_PREFIX) + (error as Error).message;

async function ready(signal?: AbortSignal): Promise<void> {
  await connect();
  signal?.throwIfAborted();
  // startTunnel returns a lifecycle handle before OpenAI /readyz or cloudflared's URL.
  // Await the existing status authority before browser work; local admission is already durable.
  await new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => { unsubscribe(); signal?.removeEventListener('abort', abort); reject(new Error('The connector did not become ready. Check its connection status and try again.')); }, 65000);
    timer.unref?.();
    const abort = () => { clearTimeout(timer); unsubscribe(); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    const inspect = () => {
      const status = getStatus();
      if (['starting-server', 'connecting-tunnel', 'offline'].includes(status.state)) return;
      clearTimeout(timer); unsubscribe(); signal?.removeEventListener('abort', abort);
      if (status.state === 'connected') resolve();
      else reject(new SetupNotReady(status.detail || 'Finish connection setup before sending.'));
    };
    unsubscribe = onStatusChange(inspect); inspect();
  });
  signal?.throwIfAborted();
  if (!await startBridge()) throw new Error('The browser bridge could not start.');
  signal?.throwIfAborted();
}
async function deliver(entry: InputEntry, retry = false, signal?: AbortSignal): Promise<InputEntry> {
  try {
    await wakeBrowser(entry, retry, signal);
    return await noteInputStartupError(entry.id, null) ?? entry;
  } catch (error) {
    return await noteInputStartupError(entry.id, `Message queued. Browser startup failed: ${(error as Error).message}`) ?? entry;
  }
}
// Only transient startup work lives here; the outbox owns accepted messages.
const starting = new Map<string, AbortController>();
let stopped = false;
export async function cancelDesktopInput(id: string): Promise<boolean> {
  const start = starting.get(id);
  start?.abort(new Error('Input cancelled'));
  return await cancelInput(id) || !!start;
}
async function startAcceptedInput(entry: InputEntry, controller: AbortController): Promise<void> {
  try {
    if (entry.steerTurnId && !entry.steerReady && entry.sessionId) {
      const { stopSessionTurn, STOP_COMMAND_TIMEOUT_MS } = await import('../bridge.js');
      const source = await getSession(entry.sessionId);
      if (source?.activeTurnId === entry.steerTurnId) await stopSessionTurn(entry.sessionId, entry.steerTurnId, entry.id);
      else if (source?.activeTurnId) throw new Error('The turn selected for steering changed');
      let deadline = Date.now() + STOP_COMMAND_TIMEOUT_MS;
      let closed = entry.steerClosedOnce === true;
      while (!await releaseSteeringInput(entry.id)) {
        controller.signal.throwIfAborted();
        const session = await getSession(entry.sessionId);
        if (session?.conversationId !== entry.conversationId || (session.activeTurnId && session.activeTurnId !== entry.steerTurnId))
          throw new Error('The turn selected for steering changed');
        const pending = (await listInputs()).find(row => row.id === entry.id);
        if (!pending || pending.state !== 'queued' || pending.cancelledByUser || pending.sendAuthorizedAt !== undefined) return;
        if (Date.now() >= deadline || (!closed && pending.steerClosedOnce)) {
          closed = pending.steerClosedOnce === true;
          await noteInputStartupError(entry.id, 'Message queued. Waiting for the exact native Stop to settle.');
          if (session?.activeTurnId === entry.steerTurnId) await stopSessionTurn(entry.sessionId, entry.steerTurnId, entry.id);
          deadline = Date.now() + STOP_COMMAND_TIMEOUT_MS;
        }
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 200); timer.unref?.(); });
      }
    }
    await ready(controller.signal);
    controller.signal.throwIfAborted();
    const current = (await listInputs()).find(row => row.id === entry.id);
    controller.signal.throwIfAborted();
    if (current?.state === 'queued') await deliver(current, false, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) await noteInputStartupError(entry.id, startupError(error));
  } finally {
    if (starting.get(entry.id) === controller) starting.delete(entry.id);
  }
}
/** Restore only pending never-Sent steering intents; delivered/uncertain rows stay inert. */
export async function resumePendingSteeringInputs(): Promise<void> {
  if (stopped) return;
  for (const row of await listInputs()) {
    if (!row.steerTurnId || row.steerReady || row.state !== 'queued' || row.owner || row.sendAuthorizedAt !== undefined ||
        row.cancelledByUser || starting.has(row.id)) continue;
    const controller = new AbortController(); starting.set(row.id, controller);
    void startAcceptedInput(row, controller).catch(() => undefined);
  }
}
/** Explicit queue steering uses the same startup and exact native Stop barrier as a fresh send. */
export async function sendQueuedDesktopInputNow(id: string, intent?: QueuedInputNowIntent): Promise<boolean> {
  if (stopped || starting.has(id) || !await sendQueuedInputNow(id, intent)) return false;
  const entry = (await listInputs()).find(row => row.id === id);
  if (!entry) return false;
  const controller = new AbortController(); starting.set(id, controller);
  void startAcceptedInput(entry, controller).catch(() => undefined);
  return true;
}
export async function sendDesktopInput(input: InputArgs, scheduleId?: string): Promise<InputEntry> {
  if (stopped) throw new Error('The app is shutting down');
  if (input.mode === 'finish' || starting.has(input.id)) return scheduleId ? enqueueInput(input, undefined, scheduleId) : enqueueInput(input);
  const controller = new AbortController(); starting.set(input.id, controller);
  try {
    const entry = scheduleId ? await enqueueInput(input, undefined, scheduleId) : await enqueueInput(input);
    if (controller.signal.aborted) { await cancelInput(input.id); controller.signal.throwIfAborted(); }
    if (entry.state !== 'queued' || entry.transportIntent === 'tool' || entry.attachmentDelivery === 'tool') {
      starting.delete(input.id); return entry;
    }
    // Return after durable admission, not after connection startup or native delivery.
    void startAcceptedInput(entry, controller).catch(() => undefined);
    return entry;
  } catch (error) {
    if (starting.get(input.id) === controller) starting.delete(input.id);
    throw error;
  }
}
export function stopInputStartup(): void {
  stopped = true;
  for (const controller of starting.values()) controller.abort(new Error('The app is shutting down'));
  starting.clear();
}
export async function retryQueuedInputBrowser(id: string): Promise<InputEntry | null> {
  if (stopped || starting.has(id)) return null;
  const eligible = (entry: InputEntry | undefined): entry is InputEntry => !!entry && entry.state === 'queued' && entry.purpose !== 'decision' && !!(entry.error?.startsWith(BROWSER_PREFIX) || entry.error?.startsWith(SETUP_PREFIX) || entry.error?.startsWith('Local chat setup failed:'));
  if (!eligible((await listInputs()).find(entry => entry.id === id)) || stopped || starting.has(id)) return null;
  const controller = new AbortController(); starting.set(id, controller);
  try {
    const repaired = await noteInputStartupError(id, null);
    if (repaired?.error?.startsWith('Local chat setup failed:')) return repaired;
    await ready(controller.signal);
    const entry = (await listInputs()).find(row => row.id === id);
    controller.signal.throwIfAborted();
    return entry?.state === 'queued' ? await deliver(entry, true, controller.signal) : null;
  } catch (error) {
    if (controller.signal.aborted) return null;
    return await noteInputStartupError(id, startupError(error));
  } finally { if (starting.get(id) === controller) starting.delete(id); }
}
export function resetInputStartupForTests(): void { stopInputStartup(); stopped = false; resetBrowserStartupForTests(); }
