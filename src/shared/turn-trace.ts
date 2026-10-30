/**
 * Gemini's own outline of one turn's work, in its order (extension/fiber.js `shellTurnTrace`).
 *
 * Gemini draws a turn as rounds: what the model says before a step, the step's calls, and a
 * one-line recap that closes the round ("Created the test files"). In a new chat's first turn
 * none of those sentences or recaps reach a message Gemini publishes, so this outline is the only
 * record of them. The timeline builds its rounds from it.
 *
 * It is presentation, kept beside the event log rather than in it: it is never a message, never a
 * call, never work or completion evidence. A `call` names Gemini's own call id, which no recorded
 * call carries. The timeline aligns this app's recorded calls with the outline's by tool and order,
 * and by `at` (when the page first showed the call, recorded only while the turn ran live) against
 * each call's start. Gemini can show a call that never reached this app, so not every item has a
 * recorded call. An `exec` is Gemini's code mode, one item for any number of this app's calls.
 */
import type { TimelineTurns } from './chronology.js';

export type TurnTraceItem =
  | { kind: 'say'; id?: string; text: string; done: boolean }
  | { kind: 'call'; id: string; tool?: string; done: boolean; at?: number }
  | { kind: 'exec'; id: string; done: boolean }
  | { kind: 'recap'; text: string }
  /** The turn's answer, by Gemini's message id: it stands after the rounds, never among them. */
  | { kind: 'answer'; id: string }
  /** What Gemini says the turn is doing right now (its open thought); present only while the turn runs. */
  | { kind: 'now'; text: string };

export type TurnTrace = TurnTraceItem[];

/** A native aggregate may retain the prior correction's entire outline. Trim
 * only a witnessed prefix within an explicitly continued recorded response.
 * Native call IDs anchor that prefix; matching words alone never remove it.
 * This is a reading projection: saved outlines and task ownership stay intact. */
export function scopeContinuedTraces(traces: Readonly<Record<string, TurnTrace>>, turns: TimelineTurns = {}): Record<string, TurnTrace> {
  const out = { ...traces };
  const callKey = (item: TurnTraceItem): string | undefined => item.kind === 'call' || item.kind === 'exec'
    ? JSON.stringify([item.kind, item.id, item.kind === 'call' ? item.tool ?? null : null]) : undefined;
  let previous: TimelineTurns[string] | undefined;
  let calls = new Set<string>(), sayings = new Set<string>();
  const ordered = Object.entries(turns).filter(([, turn]) => !turn.responseTurnId || !turns[turn.responseTurnId] ||
    turns[turn.responseTurnId]!.origin >= turn.origin).sort((a, b) => a[1].origin - b[1].origin);
  for (const [id, turn] of ordered) {
    const continues = previous?.continued === true && previous.questionId && turn.questionId &&
      previous.questionId.toLowerCase() !== turn.questionId.toLowerCase() &&
      previous.endOrigin !== undefined && previous.endOrigin < turn.origin &&
      previous.endTime !== undefined && previous.endTime <= turn.time;
    if (!continues) { calls = new Set(); sayings = new Set(); }
    const trace = traces[id];
    if (trace) {
      let lastShared = -1, newCall = false, ambiguous = false;
      const seen = new Set<string>();
      trace.forEach((item, index) => {
        const key = callKey(item);
        if (!key) return;
        if (seen.has(key)) ambiguous = true;
        seen.add(key);
        if (calls.has(key)) { if (newCall) ambiguous = true; lastShared = index; }
        else newCall = true;
      });
      if (lastShared >= 0 && !ambiguous && trace.slice(0, lastShared).every(item =>
        item.kind !== 'answer' && (item.kind !== 'say' || sayings.has(item.text)))) {
        // A recap closes the already witnessed old call. The next sentence or
        // new call starts the correction's own round, including identical words.
        let first = lastShared + 1;
        while (first < trace.length && ['recap', 'now'].includes(trace[first]!.kind)) first++;
        out[id] = trace.slice(first);
      }
      for (const item of trace) {
        const key = callKey(item); if (key) calls.add(key);
        if (item.kind === 'say') sayings.add(item.text);
      }
    }
    previous = turn;
  }
  return out;
}

export const MAX_TRACE_ITEMS = 400;
export const MAX_TRACE_SAY_CHARS = 8000;
export const MAX_TRACE_RECAP_CHARS = 300;
export const MAX_TRACE_TEXT_CHARS = 128 * 1024;

const ID = /^[A-Za-z0-9_:.-]{1,200}$/;
const TOOL = /^[A-Za-z0-9_.-]{1,100}$/;

/** Revalidates an outline that crossed from the page: bounded, typed, unknown items dropped. Null when nothing is left. */
export function turnTrace(value: unknown): TurnTrace | null {
  if (!Array.isArray(value)) return null;
  const out: TurnTrace = [];
  let room = MAX_TRACE_TEXT_CHARS;
  for (const raw of value.slice(0, MAX_TRACE_ITEMS)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === 'string' && ID.test(item.id) ? item.id : undefined;
    if (item.kind === 'say' || item.kind === 'recap' || item.kind === 'now') {
      const limit = item.kind === 'say' ? MAX_TRACE_SAY_CHARS : MAX_TRACE_RECAP_CHARS;
      const text = typeof item.text === 'string' ? item.text.slice(0, limit) : '';
      if (!text.trim() || text.length > room) continue;
      room -= text.length;
      out.push(item.kind === 'say' ? { kind: 'say', ...(id ? { id } : {}), text, done: item.done === true } : { kind: item.kind, text });
    } else if (item.kind === 'answer' && id) {
      out.push({ kind: 'answer', id });
    } else if ((item.kind === 'call' || item.kind === 'exec') && id) {
      const tool = item.kind === 'call' && typeof item.tool === 'string' && TOOL.test(item.tool) ? item.tool : undefined;
      const at = item.kind === 'call' && typeof item.at === 'number' && Number.isFinite(item.at) && item.at > 0 ? Math.round(item.at) : undefined;
      out.push(item.kind === 'call' ? { kind: 'call', id, ...(tool ? { tool } : {}), done: item.done === true, ...(at ? { at } : {}) } : { kind: 'exec', id, done: item.done === true });
    }
  }
  return out.length ? out : null;
}
