import type { ChatProvider } from './chat-provider.js';

export const FINISH_RELEASE_TEXT = {
  stop: 'Stop requested. The finish hold was released; the provider has not yet confirmed that generation stopped.',
  end: 'Finish hold released. The provider may finish its answer; generation has not been stopped.',
} as const;

/** Exact app-authored history aliases; never rewrite model prose or user names. */
export function neutralProgressCopy(text: string): string {
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
