import type { ControlApiEvent } from '../shared/control-api.js';
import { CONTROL_EVENTS_PAGE_SIZE } from '../shared/control-limits.js';

export function historyRoute(session: string, from?: number): string {
  return `sessions/${encodeURIComponent(session)}/events?limit=${CONTROL_EVENTS_PAGE_SIZE}${from === undefined ? '' : `&from=${from}`}`;
}
export function mergeHistory(previous: ControlApiEvent[], incoming: ControlApiEvent[]): ControlApiEvent[] {
  const rows = new Map(previous.map(row => [row.position, row]));
  for (const row of incoming) if (!rows.has(row.position) || rows.get(row.position)!.seq <= row.seq) rows.set(row.position, row);
  return [...rows.values()].sort((a, b) => a.position - b.position);
}
