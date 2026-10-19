let token = '';
try { token = sessionStorage.getItem('onecode-remote-session') ?? ''; } catch { /* memory-only browser */ }
export function hasRemoteToken(): boolean { return token.length > 0; }
export function setRemoteToken(value: string): void {
  token = value;
  try { if (value) sessionStorage.setItem('onecode-remote-session', value); else sessionStorage.removeItem('onecode-remote-session'); } catch { /* memory-only browser */ }
}
export class RemoteRequestError extends Error { constructor(message: string, public status: number) { super(message); } }
export class RemoteActionError extends Error {}
export async function request<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${route}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', signal,
    headers: { 'X-OneCode-Remote': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new RemoteRequestError(response.status === 401 ? 'Open your remote link again to reconnect.' : result.error ?? 'Remote request failed', response.status);
  return result as T;
}
export async function action<T>(body: Record<string, unknown>): Promise<T> {
  const result = await request<{ ok: boolean; data?: T; error?: string }>('actions', body);
  if (!result.ok) throw new RemoteActionError(result.error ?? 'Action failed');
  return result.data as T;
}
