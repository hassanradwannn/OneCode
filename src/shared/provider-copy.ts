import type { ChatProvider } from './chat-provider.js';
import { APPROVAL_ANSWERED_TEXT, APPROVAL_WAITING_TEXT } from './approval-wait.js';

export const HISTORY_RATE_LIMIT_TEXT = 'Loading this chat’s history returned HTTP 429. OneCode is waiting before retrying the history load. This is not a model context limit.';

/** Match only known app notices; native errors and quoted user/model text stay verbatim. */
export function neutralChatErrorCopy(text: string): string {
  if (text === 'The provider temporarily limited access to this conversation history. OneCode is pausing automatic recovery until the retry wait ends.' ||
      text === 'Gemini temporarily limited access to this conversation history. OneCode is pausing automatic recovery until the retry wait ends.' ||
      text === 'ChatGPT temporarily rate-limited loading this conversation history. Chat On Steroids is pausing automatic recovery until the retry wait ends.' ||
      text === 'ChatGPT temporarily rate-limited loading this conversation history. OneCode is pausing automatic recovery until the retry wait ends.') return HISTORY_RATE_LIMIT_TEXT;
  return text;
}

export const FINISH_RELEASE_TEXT = {
  stop: 'Stop requested. The finish hold was released; the provider has not yet confirmed that generation stopped.',
  end: 'Finish hold released. The provider may finish its answer; generation has not been stopped.',
} as const;

/** Exact app-authored history aliases; never rewrite model prose or user names. */
export function neutralProgressCopy(text: string): string {
  if (text === 'Gemini is waiting for you to allow or deny a tool call in this chat. Nothing continues until you answer it there.') return APPROVAL_WAITING_TEXT;
  if (text === 'The tool approval Gemini asked for in this chat was answered.') return APPROVAL_ANSWERED_TEXT;
  if (text === 'Stop requested. The finish hold was released; Gemini has not yet confirmed that generation stopped.') return FINISH_RELEASE_TEXT.stop;
  if (text === 'Finish hold released. Gemini may finish its answer; generation has not been stopped.') return FINISH_RELEASE_TEXT.end;
  return text;
}
/** Substitute app-authored provider wording before inserting any user/account arguments. */
export function providerCopy(template: string, _provider: ChatProvider, args: readonly unknown[] = [],
  words = { provider: 'provider', Provider: 'Provider', providers: 'providers' }): string {
  return template.replace(/(?:Gemini and ChatGPT|ChatGPT and Gemini) chats/g, 'chats')
    .replace(/Gemini and ChatGPT|ChatGPT and Gemini/g, words.providers)
    .replace(/Gemini|ChatGPT/g, (_match, offset: number) => offset === 0 ? words.Provider : words.provider)
    .replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < args.length ? String(args[Number(index)]) : match);
}
