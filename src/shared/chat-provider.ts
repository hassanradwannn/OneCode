/** Provider identity and URL routing shared by the app, renderer and browser companion. */
export const CHAT_PROVIDER_DEFINITIONS = {
  gemini: {
    label: 'Gemini', homeUrl: 'https://gemini.google.com/app', conversationPrefix: 'https://gemini.google.com/app/',
    conversationId: /^[0-9a-f]{16}$/i,
    capabilities: { maxMessageChars: 96_000, nativeProjects: false, nativePluginRefresh: false, generatedImageExport: true,
      handoff: 'markdown-tool' as const, receipt: 'native-question' as const }
  },
  chatgpt: {
    label: 'ChatGPT', homeUrl: 'https://chatgpt.com/', conversationPrefix: 'https://chatgpt.com/c/',
    conversationId: /^(?![0-9a-f]{16}$)[0-9a-z-]{8,64}$/i,
    capabilities: { maxMessageChars: 96_000, nativeProjects: true, nativePluginRefresh: true, generatedImageExport: true,
      handoff: 'native-answer' as const, receipt: 'fiber-question' as const }
  }
} as const;
export type ChatProvider = keyof typeof CHAT_PROVIDER_DEFINITIONS;
export const CHAT_PROVIDERS: readonly ChatProvider[] = Object.freeze(Object.keys(CHAT_PROVIDER_DEFINITIONS) as ChatProvider[]);
export const DEFAULT_CHAT_PROVIDER: ChatProvider = 'gemini';

/** Reject unknown persisted or external provider keys before any adapter lookup. */
function providerDefinition(provider: ChatProvider) {
  if (!Object.hasOwn(CHAT_PROVIDER_DEFINITIONS, provider)) throw new Error('Unsupported chat provider');
  return CHAT_PROVIDER_DEFINITIONS[provider];
}

export interface ProviderTrustSettings {
  /** Legacy value used by configs saved before provider-specific trust settings existed. */
  strictChatAllowlist?: boolean;
  strictChatAllowlistByProvider?: Partial<Record<ChatProvider, boolean>>;
}

/** Identifies a stored provider conversation without consulting the new-chat preference. */
export function chatProviderForStoredConversation(value: unknown): ChatProvider | null {
  const id = typeof value === 'string' ? value.trim() : '';
  const matches = CHAT_PROVIDERS.filter(provider => CHAT_PROVIDER_DEFINITIONS[provider].conversationId.test(id));
  return matches.length === 1 ? matches[0]! : null;
}

/** Applies the selected provider's conversation-id contract at trust and block boundaries. */
export function isChatProviderConversationId(value: unknown, provider?: ChatProvider): value is string {
  const id = typeof value === 'string' ? value.trim() : '';
  const expected = provider ?? chatProviderForStoredConversation(id);
  return !!expected && Object.hasOwn(CHAT_PROVIDER_DEFINITIONS, expected) && CHAT_PROVIDER_DEFINITIONS[expected].conversationId.test(id);
}

/**
 * Provider selection controls new chats only. Existing chats keep their provider in their
 * conversation id, so a settings change never strands an open Gemini or ChatGPT session.
 */
export function chatProviderForConversation(value: unknown, fallback: ChatProvider = DEFAULT_CHAT_PROVIDER): ChatProvider {
  return chatProviderForStoredConversation(value) ?? fallback;
}

export function chatProviderHomeUrl(provider: ChatProvider): string {
  return providerDefinition(provider).homeUrl;
}

export function chatProviderConversationUrl(provider: ChatProvider, conversationId: string): string {
  return providerDefinition(provider).conversationPrefix + encodeURIComponent(conversationId);
}

export function chatProviderLabel(provider: ChatProvider): string {
  return providerDefinition(provider).label;
}

/** Reads the independent trust-validation switch for one provider, with legacy migration. */
export function providerTrustValidationEnabled(settings: ProviderTrustSettings, provider: ChatProvider): boolean {
  return settings.strictChatAllowlistByProvider?.[provider] ?? settings.strictChatAllowlist === true;
}

export function chatProviderCapabilities(provider: ChatProvider) {
  // Conservative application transport budgets; these are not model context sizes or account quotas.
  return providerDefinition(provider).capabilities;
}
