/** Runtime adapters own capabilities. A future picker cannot enable an unimplemented path. */
export type ChatProvider = 'gemini' | 'chatgpt';
export const ACTIVE_CHAT_PROVIDER: ChatProvider = 'gemini';

export function chatProviderCapabilities(provider: ChatProvider) {
  switch (provider) {
    // Conservative application transport budgets; these are not model context sizes or account quotas.
    case 'gemini': return { maxMessageChars: 96_000, nativeProjects: false, nativePluginRefresh: false, generatedImageExport: false,
      handoff: 'markdown-tool' as const, receipt: 'native-question' as const };
    case 'chatgpt': return { maxMessageChars: 96_000, nativeProjects: true, nativePluginRefresh: true, generatedImageExport: true,
      handoff: 'native-answer' as const, receipt: 'fiber-question' as const };
    default: throw new Error('Unsupported chat provider');
  }
}
