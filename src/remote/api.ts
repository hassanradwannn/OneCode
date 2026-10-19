let token = '';
try { token = localStorage.getItem('onecode-remote-session') ?? sessionStorage.getItem('onecode-remote-session') ?? ''; } catch { /* memory-only browser */ }
// Fragments never reach HTTP logs or referrers. Keep the installation's link in
// the address so a normal browser bookmark retains its reconnect capability.
let linkKey = /^[A-Za-z0-9_-]{43}$/.test(location.hash.slice(1)) ? location.hash.slice(1) : '';
let authorityEpoch = 0, reconnecting: Promise<void> | null = null;
export function hasRemoteLink(): boolean { return !!linkKey; }
export function hasRemoteToken(): boolean { return token.length > 0; }
export function setRemoteToken(value: string): void {
  token = value;
  try { if (value) localStorage.setItem('onecode-remote-session', value); else localStorage.removeItem('onecode-remote-session'); sessionStorage.removeItem('onecode-remote-session'); } catch { /* memory-only browser */ }
}
export function forgetRemoteLink(): void {
  authorityEpoch++; linkKey = ''; setRemoteToken('');
  history.replaceState(null, '', location.pathname + location.search);
}
export class RemoteRequestError extends Error { constructor(message: string, public status: number) { super(message); } }
export class RemoteActionError extends Error {}
function send(route: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`/api/${route}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', signal,
    headers: { 'X-OneCode-Remote': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function reconnect(): Promise<void> {
  if (reconnecting) return reconnecting;
  const key = linkKey, epoch = authorityEpoch;
  if (!key) throw new RemoteRequestError('Open your bookmarked remote link to reconnect.', 401);
  const run = (async () => {
    const response = await send('connect', { key, name: /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 'Phone browser' : 'Browser' });
    const result = await response.json();
    if (!response.ok) throw new RemoteRequestError(result.error ?? 'Remote connection failed', response.status);
    if (authorityEpoch !== epoch || linkKey !== key) throw new RemoteRequestError('This browser was disconnected.', 401);
    setRemoteToken(result.token);
  })().finally(() => { if (reconnecting === run) reconnecting = null; });
  reconnecting = run; return run;
}
export async function connectRemote(): Promise<void> {
  if (hasRemoteToken()) {
    try { await request('bootstrap'); setRemoteToken(token); return; }
    catch (error) { if (!(error instanceof RemoteRequestError) || error.status !== 401 || !linkKey) throw error; }
  }
  await reconnect();
}
export async function request<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  // Opening/reloading the bookmark renews admission through connectRemote.
  // Requests within an open workspace, including revoked sessions, never replay.
  const response = await send(route, body, signal);
  const result = await response.json();
  if (!response.ok) throw new RemoteRequestError(response.status === 401 ? 'Open your remote link again to reconnect.' : result.error ?? 'Remote request failed', response.status);
  return result as T;
}
export async function action<T>(body: Record<string, unknown>): Promise<T> {
  const result = await request<{ ok: boolean; data?: T; error?: string }>('actions', body);
  if (!result.ok) throw new RemoteActionError(result.error ?? 'Action failed');
  return result.data as T;
}
