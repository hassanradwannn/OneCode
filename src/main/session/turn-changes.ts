import { completedTurnIds } from '../../shared/markdown-export.js';
import { summarizeTurnChanges, type TurnFileChange } from '../../shared/turn-changes.js';
import { readEvents } from './store.js';

export async function readTurnChanges(sessionId: string, turnId: string): Promise<TurnFileChange[]> {
  const events = await readEvents(sessionId, { kinds: ['tool_call', 'turn_end'] });
  if (!completedTurnIds(events).has(turnId)) throw new Error('This turn has not completed.');
  return summarizeTurnChanges(events.flatMap(event => event.kind === 'tool_call' && event.turnId === turnId ? [event.call] : []));
}
