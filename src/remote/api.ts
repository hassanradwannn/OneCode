import type { RemoteBootstrap } from '../shared/remote.js';

let token = '';
try { token = localStorage.getItem('onecode-remote-session') ?? sessionStorage.getItem('onecode-remote-session') ?? ''; } catch { /* memory-only browser */ }
// Fragments never reach HTTP logs or referrers. Keep the installation's link in
// the address so a normal browser bookmark retains its reconnect capability.
let linkKey = /^[A-Za-z0-9_-]{43}$/.test(location.hash.slice(1)) ? location.hash.slice(1) : '';
let pairingKey = /^#pair=([A-Za-z0-9_-]{43})$/.exec(location.hash)?.[1] ?? '';
if (pairingKey) history.replaceState(null, '', location.pathname + location.search);
let authorityEpoch = 0, reconnecting: Promise<void> | null = null;
export function hasRemoteLink(): boolean { return !!(linkKey || pairingKey); }
export function hasRemoteToken(): boolean { return token.length > 0; }
export function setRemoteToken(value: string): void {
  token = value;
  try { if (value) localStorage.setItem('onecode-remote-session', value); else localStorage.removeItem('onecode-remote-session'); sessionStorage.removeItem('onecode-remote-session'); } catch { /* memory-only browser */ }
}
export function forgetRemoteLink(): void {
  authorityEpoch++; linkKey = ''; pairingKey = ''; setRemoteToken('');
  history.replaceState(null, '', location.pathname + location.search);
}
export class RemoteRequestError extends Error { constructor(message: string, public status: number) { super(message); } }
export class RemoteActionError extends Error {}
async function send(route: string, body?: unknown, signal?: AbortSignal): Promise<{ response: Response; result: any }> {
  const deadline = AbortSignal.timeout(body === undefined || route === 'connect' ? 30_000 : 120_000);
  try {
  const response = await fetch(`/api/${route}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    headers: { 'X-OneCode-Remote': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { response, result: await response.json() };
  } catch (error) {
    if (deadline.aborted && !signal?.aborted)
      throw new RemoteRequestError('Connection timed out. Check the host’s connection and keep OneCode running. Check the chat before resending an interrupted action.', 503);
    throw error;
  }
}
async function reconnect(): Promise<void> {
  if (reconnecting) return reconnecting;
  const key = pairingKey || linkKey, epoch = authorityEpoch;
  if (!key) throw new RemoteRequestError('Copy a pairing or access link from OneCode Settings → Remote.', 401);
  const run = (async () => {
    const { response, result } = await send('connect', { key, name: /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 'Phone browser' : 'Browser' });
    if (!response.ok) throw new RemoteRequestError(result.error ?? 'Remote connection failed', response.status);
    if (authorityEpoch !== epoch || (pairingKey || linkKey) !== key) throw new RemoteRequestError('This browser was disconnected.', 401);
    pairingKey = '';
    setRemoteToken(result.token);
  })().finally(() => { if (reconnecting === run) reconnecting = null; });
  reconnecting = run; return run;
}
export async function connectRemote(): Promise<RemoteBootstrap | null> {
  if (pairingKey && hasRemoteToken()) {
    try {
      const bootstrap = await request<RemoteBootstrap>('bootstrap');
      pairingKey = '';
      return bootstrap;
    } catch (error) {
      if (!(error instanceof RemoteRequestError) || error.status !== 401) throw error;
    }
    await reconnect();
    return request<RemoteBootstrap>('bootstrap');
  }
  if (hasRemoteToken()) {
    try { const bootstrap = await request<RemoteBootstrap>('bootstrap'); setRemoteToken(token); return bootstrap; }
    catch (error) {
      if (!(error instanceof RemoteRequestError) || error.status !== 401 || !linkKey) throw error;
      throw new RemoteRequestError('This browser was disconnected. Select Reconnect to request access again.', 401);
    }
  }
  await reconnect();
  return request<RemoteBootstrap>('bootstrap');
}
/** Re-enrollment is available only after an explicit user action. */
export async function reconnectRemote(): Promise<void> { await reconnect(); }
export async function request<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  // Workspace requests never re-enroll a browser after a revoked session or replay an action.
  const { response, result } = await send(route, body, signal);
  if (!response.ok) throw new RemoteRequestError(response.status === 401 ? 'Open your remote link again to reconnect.' : result.error ?? 'Remote request failed', response.status);
  return result as T;
}
export async function action<T>(body: Record<string, unknown>): Promise<T> {
  const result = await request<{ ok: boolean; data?: T; error?: string }>('actions', body);
  if (!result.ok) throw new RemoteActionError(result.error ?? 'Action failed');
  return result.data as T;
}
