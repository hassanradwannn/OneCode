import type { ChatProvider } from './chat-provider.js';
/** Substitute app-authored provider wording before inserting any user/account arguments. */
export function providerCopy(template: string, _provider: ChatProvider, args: readonly unknown[] = []): string {
  return template.replace(/(?:Gemini and ChatGPT|ChatGPT and Gemini) chats/g, 'chats')
    .replace(/Gemini and ChatGPT|ChatGPT and Gemini/g, 'providers')
    .replace(/Gemini|ChatGPT/g, 'provider').replace(/^provider\b/, 'Provider')
    .replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < args.length ? String(args[Number(index)]) : match);
}
