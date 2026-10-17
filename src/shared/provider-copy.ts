import { chatProviderLabel, type ChatProvider } from './chat-provider.js';
/** Substitute app-authored provider wording before inserting any user/account arguments. */
export function providerCopy(template: string, provider: ChatProvider, args: readonly unknown[] = []): string {
  return template.replaceAll('Gemini', chatProviderLabel(provider))
    .replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < args.length ? String(args[Number(index)]) : match);
}
