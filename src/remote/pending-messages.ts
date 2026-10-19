import type { ControlApiEvent, ControlApiInput } from '../shared/control-api.js';
export type OptimisticMessage = { id: string; sessionId: string | null; text: string; state: 'sending' | 'accepted' | 'unconfirmed'; receipt?: ControlApiInput };
/** Receipt identity is the only join; identical text and nearby timestamps prove nothing. */
export function pendingMessages(rows: OptimisticMessage[], inputs: ControlApiInput[], events: ControlApiEvent[], sessionId: string | null): OptimisticMessage[] {
  return rows.flatMap(row => {
    const receipt = inputs.find(input => input.id === row.id) ?? row.receipt;
    const target = receipt?.deliveredSessionId ?? receipt?.sessionId ?? row.sessionId;
    if (target !== sessionId) return [];
    if (events.some(event => event.kind === 'user_message' && (event.inputId === row.id || !!receipt?.messageId && event.messageId === receipt.messageId))) return [];
    return [{ ...row, receipt }];
  });
}
