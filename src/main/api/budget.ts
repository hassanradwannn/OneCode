import { estimateTokens } from '../../shared/session.js';
import { ApiError, type ApiMessage, type ApiModel } from './types.js';

/** Respect the selected model and the remaining context, rather than a fixed 16K ceiling. */
export function apiOutputBudget(model: ApiModel, messages: ApiMessage[], tools: object[], desired = 65_536): { output: number; maximum: number } {
  const used = estimateTokens(JSON.stringify(messages)) + estimateTokens(JSON.stringify(tools)) + 512;
  const maximum = Math.min(model.maxCompletionTokens ?? 32_768, Math.floor(model.contextLength - used));
  if (maximum < 512) throw new ApiError('CONTEXT_LIMIT');
  return { output: Math.min(desired, maximum), maximum };
}
