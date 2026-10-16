import type { GeminiInputTurn } from './bindings.js';
import { positionOf } from '../../shared/chronology.js';
import { getSession, readLatestUserMessage } from '../session/store.js';

export type GeminiQuestionStatus = { state: 'pending' | 'invalid' } | { state: 'ready'; turn: GeminiInputTurn };
/** Resolve one already committed local Send receipt, never the latest unowned input. */
export async function geminiQuestionTurnStatus(sessionId: string, conversationId: string,
  receipt: Omit<GeminiInputTurn, 'turnId'>): Promise<GeminiQuestionStatus> {
  const session = await getSession(sessionId);
  if (session?.conversationId !== conversationId) return { state: 'invalid' };
  const question = await readLatestUserMessage(sessionId);
  if (!question || positionOf(question) < receipt.historySeq) return { state: 'pending' };
  if (question.messageId !== receipt.messageId || question.inputId !== receipt.inputId || positionOf(question) !== receipt.historySeq)
    return { state: 'invalid' };
  const turns = Object.entries(session.timelineTurns ?? {}).filter(([, turn]) => turn.questionId === receipt.messageId);
  if (turns.length > 1 || turns.some(([, turn]) => turn.endOrigin !== undefined)) return { state: 'invalid' };
  if (!session.activeTurnId || !turns.length) return { state: 'pending' };
  const active = session.timelineTurns?.[session.activeTurnId];
  if (!active || active.questionId !== receipt.messageId)
    return { state: active && active.origin >= receipt.historySeq ? 'invalid' : 'pending' };
  return { state: 'ready', turn: { ...receipt, turnId: session.activeTurnId } };
}
