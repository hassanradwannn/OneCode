import type { SessionEvent, SessionSummary } from '../shared/session.js';
import { positionOf } from '../shared/chronology.js';
import { usageLimitResetText, usageLimitTitle } from '../shared/provider-usage-limit.js';

type Notice = Extract<SessionEvent, { kind: 'chat_error' }>;
export interface UsageLimitNotifierDeps {
  getSession(id: string): Promise<SessionSummary | null>;
  events(id: string): Promise<readonly SessionEvent[]>;
  enabled(): boolean;
  focused(): boolean;
  show(title: string, body: string, sessionId: string): void;
  now?(): number;
}

/** One notice per native blocked episode; countdown edits neither notify nor replay work. */
export function createUsageLimitNotifier(deps: UsageLimitNotifierDeps) {
  const startedAt = (deps.now ?? Date.now)();
  const episodes = new Map<string, { event: Notice; position: number }>();
  const seen = new Map<string, number>(), pending = new Set<string>();
  let flight: Promise<void> | null = null;
  const scan = async (sessionIds: readonly string[]): Promise<void> => {
    for (const id of sessionIds) {
      const session = await deps.getSession(id).catch(() => null);
      if (!session) continue;
      const events = [...await deps.events(id).catch(() => [])].sort((a, b) => positionOf(a) - positionOf(b));
      const prior = seen.get(id) ?? 0;
      seen.set(id, Math.max(prior, ...events.map(event => event.seq)));
      if (seen.size > 1000) seen.delete(seen.keys().next().value!);
      for (const event of events) {
        if (event.seq <= prior || event.time < startedAt) continue;
        if (event.kind === 'assistant_message' && event.final === true) {
          for (const [key, episode] of episodes) if (key.startsWith(`${id}:`) && positionOf(event) > episode.position) episodes.delete(key);
        }
        if (event.kind !== 'chat_error' || event.blocking !== true || !event.usageLimit) continue;
        const key = `${id}:${event.usageLimit.kind}`, previous = episodes.get(key);
        if (previous) {
          const before = previous.event.usageLimit!.resetAt, next = event.usageLimit.resetAt;
          const newWindow = before !== undefined && next !== undefined && next > before && event.time >= before;
          if (!newWindow) continue;
        }
        episodes.set(key, { event, position: positionOf(event) });
        if (episodes.size > 1000) episodes.delete(episodes.keys().next().value!);
        if (!deps.enabled() || deps.focused()) continue;
        const reset = usageLimitResetText(event.usageLimit);
        deps.show(session.title || 'OneCode', `${usageLimitTitle(event.usageLimit)}.${reset ? ` Reset reported: ${reset}.` : ' The provider did not report a reset time.'}`, id);
      }
    }
  };
  return { handle(sessionIds: readonly string[]): Promise<void> {
    for (const id of sessionIds) pending.add(id);
    if (flight) return flight;
    flight = (async () => {
      while (pending.size) { const ids = [...pending]; pending.clear(); await scan(ids); }
    })().finally(() => { flight = null; });
    return flight;
  } };
}
