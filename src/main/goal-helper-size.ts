/** Adaptive helper transport budget, learned from unanswered sends.
 * This is an application delivery limit, not a provider context-window claim.
 * Never-sent prompts provide no evidence; learned reductions expire after a week.
 */
import { MAX_BROWSER_MESSAGE_CHARS } from '../shared/user-prompt.js';
import { writeDurableSoon } from './durable.js';
import { logInfo } from './logger.js';

export const GOAL_HELPER_SIZE_STATE = 'goal-helper-size';
/** Below this a prompt that went unanswered says nothing about its size. */
export const GOAL_HELPER_SIZE_FLOOR = 16_000;
const SHRINK = 0.6;
const FORGET_AFTER_MS = 7 * 24 * 60 * 60_000;

export interface GoalHelperSizeSnapshot { version: 1; limit: number; learnedAt: number }

let learned: GoalHelperSizeSnapshot | null = null;

/** The longest helper prompt to send now. */
export function goalHelperPromptLimit(now = Date.now()): number {
  if (!learned || now - learned.learnedAt >= FORGET_AFTER_MS) return MAX_BROWSER_MESSAGE_CHARS;
  return Math.min(MAX_BROWSER_MESSAGE_CHARS, learned.limit);
}

/** A prompt of this length was taken by Gemini and timed out without an answer. */
export function noteGoalHelperUnanswered(promptChars: number, now = Date.now()): void {
  if (!Number.isFinite(promptChars) || promptChars <= GOAL_HELPER_SIZE_FLOOR) return;
  const limit = Math.max(GOAL_HELPER_SIZE_FLOOR, Math.floor(promptChars * SHRINK));
  if (limit >= goalHelperPromptLimit(now)) return;
  learned = { version: 1, limit, learnedAt: now };
  writeDurableSoon(GOAL_HELPER_SIZE_STATE, learned);
  logInfo(`goal: the provider took a ${promptChars}-character helper prompt and never answered; the next ones stay under ${limit} characters`);
}

export function restoreGoalHelperSize(saved: unknown): void {
  const value = saved as Partial<GoalHelperSizeSnapshot> | null;
  learned = value?.version === 1 && Number.isFinite(value.limit) && Number.isFinite(value.learnedAt) &&
    value.limit! >= GOAL_HELPER_SIZE_FLOOR && value.limit! <= MAX_BROWSER_MESSAGE_CHARS
    ? { version: 1, limit: Math.floor(value.limit!), learnedAt: value.learnedAt! } : null;
}

export function resetGoalHelperSizeForTests(): void {
  learned = null;
}
