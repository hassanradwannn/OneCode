import { estimateTokens } from '../../shared/session.js';
import { ApiError, type ApiMessage, type ApiModel } from './types.js';

/** Base64 occupies transport bytes. Model context sees decoded media. */
export function apiTextProjection(message: ApiMessage): ApiMessage {
  if (message.role !== 'user' || typeof message.content === 'string') return message;
  return { role: 'user', content: message.content.map(part => {
    if (part.type === 'text') return part.text;
    if (part.type === 'file') return '[Attached PDF ' + part.file.filename + ']';
    return part.type === 'image_url' ? '[Attached image]' : part.type === 'input_audio' ? '[Attached audio]' : '[Attached video]';
  }).join('\n') };
}

export function apiMessageTokens(messages: ApiMessage[]): number {
  let mediaTokens = 0;
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type !== 'text') mediaTokens += part.type === 'image_url' ? 1024 : 2048;
    }
  }
  return estimateTokens(JSON.stringify(messages.map(apiTextProjection))) + mediaTokens;
}

/** Respect the selected model and the remaining context, rather than a fixed 16K ceiling. */
export function apiOutputBudget(model: ApiModel, messages: ApiMessage[], tools: object[], desired = 65_536): { output: number; maximum: number } {
  const used = apiMessageTokens(messages) + estimateTokens(JSON.stringify(tools)) + 512;
  const maximum = Math.min(model.maxCompletionTokens ?? 32_768, Math.floor(model.contextLength - used));
  if (maximum < 512) throw new ApiError('CONTEXT_LIMIT');
  return { output: Math.min(desired, maximum), maximum };
}
