import { DEFAULT_HANDOFF_LENGTH, DEFAULT_HANDOFF_PROMPT, handoffPromptForLength, type HandoffLength } from '../../shared/handoff.js';

/**
 * What a handoff brief has to contain, in one place.
 *
 * The source conversation writes its own brief. The provider adapter determines delivery:
 * Gemini calls the exact scoped save_handoff tool; legacy ChatGPT captures its bound final
 * answer. Both use the same document requirements and continuation markers.
 */

/**
 * The instruction typed into the provider conversation being compacted.
 *
 * The model is already the participant rather than a reader of a transcript, so there is no
 * recording to hand it and "the tool evidence" is its own call history.
 *
 * Gemini's file save is idempotent under the existing continuation WAL and exact source Send
 * receipt. It never treats prose as proof that a file was saved. The legacy ChatGPT branch
 * retains its generation-bound answer capture; unsupported providers need their own adapter.
 */
const marker = (kind: 'HANDOFF' | 'RESUME', token: string): string =>
  token ? `[[CLF-${kind}:${token}]]` : '';

export const sourceContinuationMarker = (token: string): string => marker('HANDOFF', token);
export const destinationContinuationMarker = (token: string): string => marker('RESUME', token);

export function nativeHandoffPrompt(
  token = '',
  includeToolCalls = true,
  handoffPrompt = DEFAULT_HANDOFF_PROMPT,
  length: HandoffLength = DEFAULT_HANDOFF_LENGTH,
  provider: 'chatgpt' | 'gemini' = 'chatgpt'
): string {
  const identity = sourceContinuationMarker(token);
  const briefInstructions = handoffPromptForLength(handoffPrompt.trim() || DEFAULT_HANDOFF_PROMPT, length);
  return (
    (identity ? `${identity}\n\n` : '') +
    'OneCode is compacting this conversation so a fresh chat can continue the work. ' +
    'Stop whatever you were doing and do only this.\n\n' +
    'Write a handoff brief so a different coding agent can continue this unfinished task in a brand-new ' +
    "conversation, with no memory of anything here. Everything you know about this session — the user's " +
    (includeToolCalls ? 'messages, your own replies, and every tool call you made against this machine with its result — is the ' :
      'messages and your own replies, including interim updates — is the ') +
    'material. Write it so an agent who reads only your brief can carry on correctly.\n\n' +
    `${briefInstructions}\n\n` +
    (includeToolCalls ? '' : 'Tool-detail setting: preserve verified outcomes and distinguish them from claims, but omit raw tool-call arguments and result bodies from the brief. Do not copy tool transcripts. This setting controls the brief, not the history you already saw.\n\n') +
    (provider === 'gemini'
      ? `Save the complete brief as Markdown by directly calling the CURRENT OneCode Core save_handoff tool with token="${token}" and markdown containing the complete document. ` +
        'The tool saves an app-owned .md file; do not supply a path, use workspace writes, or call any other tool. ' +
        'Do not copy session credentials, control frames, or this continuation token into the document. ' +
        'Use only the currently exposed tool schema, never a namespace copied from older turns. ' +
        'The app opens the successor only after the file and its receipt are durable. A prose reply alone does not save it. ' +
        'If the result is lost, retry the same token and document; the tool returns the existing stored receipt without rewriting it.'
      : 'Your reply to this message must be the complete Markdown document itself and nothing else: no preamble, no closing remark, no ' +
        'question back, and no tool calls, including save_handoff. OneCode automatically saves your reply as a .md file, verifies it, and opens the fresh chat with its complete contents. Do not attempt a tool-based save.')
  );
}
