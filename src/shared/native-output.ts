import { chatProviderForStoredConversation, type ChatProvider } from './chat-provider.js';

export type NativeOutputKind = 'image' | 'video' | 'artifact';
interface NativeOutputAdapter {
  message: (id: string, conversationId: string) => boolean;
  mediaAsset: (id: string, kind: 'image' | 'video') => boolean;
  artifact: (id: string) => boolean;
  revision: (id: string) => boolean;
  roles: readonly string[];
  /** The actual browser export representation, independently of normalized admission. */
  exports: Readonly<Record<'image' | 'video', 'original' | 'rendered' | false>>;
  snapshotSurfaces: readonly string[];
}
const opaqueId = (id: string): boolean => /^[A-Za-z0-9_-]{1,160}$/.test(id);
const uuid = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/**
 * The only provider-specific native-output admission rules. Browser adapters must supply
 * witnessed, non-secret identities, never URLs, positional DOM ids or a fabricated revision.
 * Registering transport syntax does not implement observation or authenticate a tool caller.
 * Adding a provider requires an explicit contract here as well as its browser adapter.
 */
export const NATIVE_OUTPUT_ADAPTERS = {
  chatgpt: {
    message: uuid, mediaAsset: (id: string) => /^file_[A-Za-z0-9_-]{8,100}$/.test(id),
    artifact: (id: string) => /^[A-Za-z0-9_-]{8,160}$/.test(id), revision: (id: string) => /^\d{1,16}$/.test(id),
    roles: ['tool', 'assistant'], exports: { image: 'original', video: 'original' }, snapshotSurfaces: []
  },
  gemini: {
    // The existing adapter's rendered exchange/response identity. Its document-N fallback
    // cannot own imported output across reloads. Keep the conversation inside the message id.
    message: (id: string, conversationId: string) => {
      const prefix = `gemini:${conversationId}:assistant:`;
      if (!id.startsWith(prefix)) return false;
      const native = id.slice(prefix.length);
      return /^(?:[0-9a-f]{16}|message-content-id-r_[0-9a-f]{16}|r_[0-9a-f]{16})$/i.test(native);
    },
    // Native generated-image attachment index, scoped by the exact response message above.
    mediaAsset: (id: string, kind: 'image' | 'video') => kind === 'image' ? /^image_(?:0|[1-9]\d{0,3})$/.test(id) : id === 'video',
    artifact: opaqueId, revision: opaqueId,
    roles: ['assistant'], exports: { image: 'rendered', video: 'original' }, snapshotSurfaces: ['canvas']
  }
} satisfies Record<ChatProvider, NativeOutputAdapter>;

/** A rendered native surface with no durable provider revision gets a local source snapshot. */
export function admitNativeArtifactSnapshot(input: {conversationId: string; provider: unknown; messageId: unknown; surface: unknown}): ChatProvider | null {
  const provider = chatProviderForStoredConversation(input.conversationId);
  if (!provider || input.provider !== provider || typeof input.messageId !== 'string' || typeof input.surface !== 'string') return null;
  const adapter: NativeOutputAdapter = NATIVE_OUTPUT_ADAPTERS[provider];
  return adapter.message(input.messageId, input.conversationId) && adapter.snapshotSurfaces.includes(input.surface) ? provider : null;
}

export function nativeOutputAdapter(conversationId: string): NativeOutputAdapter | null {
  const provider = chatProviderForStoredConversation(conversationId);
  return provider ? NATIVE_OUTPUT_ADAPTERS[provider] : null;
}

export function admitNativeOutputIdentity(input: {
  kind: NativeOutputKind; conversationId?: string; provider?: unknown; messageId: unknown;
  assetId: unknown; revisionId?: unknown; parentRevisionId?: unknown; role?: unknown;
}): ChatProvider | null {
  if (!input.conversationId) return null;
  const provider = chatProviderForStoredConversation(input.conversationId);
  if (!provider) return null;
  // Older ChatGPT companions did not stamp provider. Their strict tuple remains compatible.
  if (input.provider !== provider && !(input.provider === undefined && provider === 'chatgpt' && input.kind !== 'artifact')) return null;
  const adapter: NativeOutputAdapter = NATIVE_OUTPUT_ADAPTERS[provider];
  if (typeof input.messageId !== 'string' || !adapter.message(input.messageId, input.conversationId) ||
      typeof input.assetId !== 'string') return null;
  if (input.kind !== 'artifact') return adapter.mediaAsset(input.assetId, input.kind) && adapter.roles.includes(String(input.role)) ? provider : null;
  if (!adapter.artifact(input.assetId) || typeof input.revisionId !== 'string' || !adapter.revision(input.revisionId)) return null;
  if (input.parentRevisionId !== undefined && (typeof input.parentRevisionId !== 'string' || !adapter.revision(input.parentRevisionId))) return null;
  return provider;
}

export function canExportNativeOutput(conversationId: string, kind: 'image' | 'video'): boolean {
  return !!nativeOutputAdapter(conversationId)?.exports[kind];
}

export function nativeOutputExportRepresentation(conversationId: string, kind: 'image' | 'video'): 'original' | 'rendered' | false {
  return nativeOutputAdapter(conversationId)?.exports[kind] ?? false;
}
