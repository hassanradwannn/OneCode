/** Provider identity and URL routing shared by the app, renderer and browser companion. */
export type ChatProvider = 'gemini' | 'chatgpt';
export const CHAT_PROVIDERS = ['gemini', 'chatgpt'] as const satisfies readonly ChatProvider[];
export const DEFAULT_CHAT_PROVIDER: ChatProvider = 'gemini';

export interface ProviderTrustSettings {
  /** Legacy value used by configs saved before provider-specific trust settings existed. */
  strictChatAllowlist?: boolean;
  strictChatAllowlistByProvider?: Partial<Record<ChatProvider, boolean>>;
}

const GEMINI_CONVERSATION_ID = /^[0-9a-f]{16}$/i;
const CHATGPT_CONVERSATION_ID = /^[0-9a-z-]{8,64}$/i;

/** Identifies a stored provider conversation without consulting the new-chat preference. */
export function chatProviderForStoredConversation(value: unknown): ChatProvider | null {
  const id = typeof value === 'string' ? value.trim() : '';
  if (GEMINI_CONVERSATION_ID.test(id)) return 'gemini';
  if (CHATGPT_CONVERSATION_ID.test(id)) return 'chatgpt';
  return null;
}

/** Applies the selected provider's conversation-id contract at trust and block boundaries. */
export function isChatProviderConversationId(value: unknown, provider?: ChatProvider): value is string {
  const id = typeof value === 'string' ? value.trim() : '';
  const expected = provider ?? chatProviderForStoredConversation(id);
  if (expected === 'gemini') return GEMINI_CONVERSATION_ID.test(id);
  if (expected === 'chatgpt') return CHATGPT_CONVERSATION_ID.test(id) && !GEMINI_CONVERSATION_ID.test(id);
  return false;
}

/**
 * Provider selection controls new chats only. Existing chats keep their provider in their
 * conversation id, so a settings change never strands an open Gemini or ChatGPT session.
 */
export function chatProviderForConversation(value: unknown, fallback: ChatProvider = DEFAULT_CHAT_PROVIDER): ChatProvider {
  return chatProviderForStoredConversation(value) ?? fallback;
}

export function chatProviderHomeUrl(provider: ChatProvider): string {
  return provider === 'chatgpt' ? 'https://chatgpt.com/' : 'https://gemini.google.com/app';
}

export function chatProviderConversationUrl(provider: ChatProvider, conversationId: string): string {
  return provider === 'chatgpt'
    ? `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`
    : `https://gemini.google.com/app/${encodeURIComponent(conversationId)}`;
}

export function chatProviderLabel(provider: ChatProvider): string {
  return provider === 'chatgpt' ? 'ChatGPT' : 'Gemini';
}

/** Reads the independent trust-validation switch for one provider, with legacy migration. */
export function providerTrustValidationEnabled(settings: ProviderTrustSettings, provider: ChatProvider): boolean {
  return settings.strictChatAllowlistByProvider?.[provider] ?? settings.strictChatAllowlist === true;
}

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
