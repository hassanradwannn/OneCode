import { liveConversations } from './session/recorder.js';
import { pendingCommands, stopSessionTurn } from './bridge.js';
import { performance } from 'node:perf_hooks';
import { logWarn } from './logger.js';

/** Explicit Update now requests native Stop while Companion is still connected.
 * Each exact turn uses the ordinary durable Stop owner. Local child termination and
 * output sealing remain in shutdown; no provider request is replayed here.
 */
export async function requestProviderStopsForUpdate(): Promise<void> {
  const targets = liveConversations().filter(row => row.sessionId && row.activeTurnId);
  for (let offset = 0; offset < targets.length; offset += 3) {
    const results = await Promise.allSettled(targets.slice(offset, offset + 3).map(row =>
      stopSessionTurn(row.sessionId!, row.activeTurnId!)));
    if (results.some(result => result.status === 'rejected'))
      logWarn('update: a provider Stop request could not be confirmed; no native completion is inferred');
  }
  // Keep Companion connected long enough to fetch the exact newly queued commands.
  // Queue publication alone does not mean the native Stop control was reached.
  const keys = new Set(targets.map(row => `stop:${row.sessionId}:${row.activeTurnId}`));
  const ids = new Set(pendingCommands().filter(row => keys.has(row.what)).map(row => row.id));
  const deadline = performance.now() + 5_000;
  while (pendingCommands().some(row => ids.has(row.id)) && performance.now() < deadline) {
    await new Promise<void>(resolve => { const timer = setTimeout(resolve, 100); timer.unref?.(); });
  }
  if (pendingCommands().some(row => ids.has(row.id)) || liveConversations().some(row =>
    targets.some(target => target.sessionId === row.sessionId && target.activeTurnId === row.activeTurnId)))
    logWarn('update: native Stop remains unconfirmed; continuing the explicit restart without claiming provider completion');
}
