import type { SessionEvent } from '../shared/session.js';
import { userPromptText } from '../shared/user-prompt.js';

const WARMUP = '[[GEMINI_LOCAL_WARMUP]] Initialize this local workspace conversation. Reply READY only. Do not call tools.';

/** Display only: a valid setup frame may follow the native connector mention. */
export function geminiUserText(value: string): string {
  const text = value.trimStart(), direct = userPromptText(text);
  if (direct !== null) return direct;
  for (const opening of ['[[COS_CONTEXT:', '\\[\\[COS\\_CONTEXT\\:']) {
    const at = text.indexOf(opening);
    if (at > 0 && /^@[^\r\n\[\]\\]{1,120}\s*$/.test(text.slice(0, at))) {
      const authored = userPromptText(text.slice(at));
      if (authored !== null) return authored;
    }
  }
  return value;
}

/** Hide only the first native setup exchange in the view; retain durable evidence. */
export function geminiVisibleEvents(source: readonly SessionEvent[]): SessionEvent[] {
  let firstUser = true, warming = false;
  return source.filter(event => {
    if (event.kind === 'user_message') {
      const value = event.message.text.trim().replace(/\s+/g, ' ');
      const internal = firstUser && event.messageId?.startsWith('gemini:') === true &&
        // Read-only migration: keep previously recorded setup exchanges hidden after rebranding.
        (value === WARMUP || value === '@onecode-gemini ' + WARMUP || value === '@gemini-code ' + WARMUP);
      firstUser = false; warming = internal;
      return !internal;
    }
    if (!warming) return true;
    if (event.kind === 'assistant_message') return event.message.text.trim() !== 'READY';
    if (event.kind === 'turn_start' || event.kind === 'turn_end' || event.kind === 'progress') return false;
    // A real execution or error is material, even in an unexpected setup exchange.
    if (event.kind === 'tool_call' || event.kind === 'chat_error') warming = false;
    return true;
  });
}
