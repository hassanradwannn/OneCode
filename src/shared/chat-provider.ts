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
  },
  claude: {
    label: 'Claude', homeUrl: 'https://claude.ai/new', conversationPrefix: 'https://claude.ai/chat/',
    conversationId: /^claude:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,
    capabilities: { maxMessageChars: 96_000, nativeProjects: false, nativePluginRefresh: false, generatedImageExport: false,
      handoff: 'markdown-tool' as const, receipt: 'native-question' as const }
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

/** Native connection settings for the explicitly selected provider. */
export function chatProviderConnectionsUrl(provider: ChatProvider): string {
  providerDefinition(provider);
  return { gemini: 'https://gemini.google.com/customize/connectors', chatgpt: 'https://chatgpt.com/plugins',
    claude: 'https://claude.ai/customize/connectors' }[provider];
}

export function chatProviderConversationUrl(provider: ChatProvider, conversationId: string): string {
  if (provider === 'claude' && !isChatProviderConversationId(conversationId, provider)) throw new Error('Unsupported provider conversation');
  return providerDefinition(provider).conversationPrefix + encodeURIComponent(provider === 'claude' ? conversationId.trim().slice('claude:'.length).toLowerCase() : conversationId);
}

/** A native service UUID is namespaced before it enters shared session storage. */
export function chatProviderConversationIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (url.hostname === 'claude.ai') {
      const native = /^\/chat\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i.exec(url.pathname)?.[1];
      return native ? `claude:${native.toLowerCase()}` : null;
    }
    if (url.hostname === 'gemini.google.com') return /^\/(?:u\/\d+\/)?app\/([0-9a-f]{16})\/?$/i.exec(url.pathname)?.[1]?.toLowerCase() ?? null;
    if (url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com') {
      const id = /^\/(?:g\/[^/]+\/)?c\/([0-9a-z-]+)\/?$/i.exec(url.pathname)?.[1];
      return id && isChatProviderConversationId(id, 'chatgpt') ? id : null;
    }
  } catch { /* Invalid URLs supply no provider identity. */ }
  return null;
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
