/** The API runner's live turn owner, shared with presentation without browser observations. */
export interface ApiActivity {
  phase: 'catalog' | 'preparing' | 'requesting' | 'responding' | 'preparing-tool' | 'recovering';
  inputId?: string;
  since?: number;
  requestBytes?: number;
  tool?: string;
  attempt?: number;
  retryAt?: number;
  reason?: string;
}
export interface ActiveApiTurn {
  sessionId: string;
  turnId: string | null;
  controller: AbortController;
  activity: ApiActivity;
  deliveryPending?: boolean;
}
export const apiTurns = new Map<string, ActiveApiTurn>();
export function apiTurnStatus(sessionId: string, turnId: string | null): 'running' | 'stopping' | null {
  if (!turnId) return null;
  const active = [...apiTurns.values()].find(item => item.sessionId === sessionId && item.turnId === turnId);
  return active ? active.controller.signal.aborted ? 'stopping' : 'running' : null;
}
export function apiActivity(sessionId: string, turnId: string | null): ApiActivity | null {
  const active = [...apiTurns.values()].find(item => item.sessionId === sessionId &&
    (turnId ? item.turnId === turnId : item.deliveryPending === true));
  return active && !active.controller.signal.aborted ? { ...active.activity } : null;
}
