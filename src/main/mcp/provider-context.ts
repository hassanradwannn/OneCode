import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChatProvider } from '../../shared/chat-provider.js';

// The listening server owns this identity. Never infer it from a client header,
// a model argument, or the UI's mutable preference for new conversations.
const providerContext = new AsyncLocalStorage<ChatProvider>();
export const mcpProvider = (): ChatProvider => providerContext.getStore() ?? 'gemini';
export const withMcpProvider = <T>(provider: ChatProvider, run: () => T): T => providerContext.run(provider, run);
