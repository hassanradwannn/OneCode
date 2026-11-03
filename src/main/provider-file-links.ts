/** Recorded provider-file membership shared by trusted Desktop and Remote clicks. */
import { safeProviderFileLink } from '../shared/external-link.js';
import { chatProviderForStoredConversation, chatProviderConversationUrl } from '../shared/chat-provider.js';
import { getSession, readEvents } from './session/store.js';

export async function recordedProviderFileLink(id: string, messageId: string, href: string): Promise<{ conversationId: string; url: string }> {
  if (!safeProviderFileLink(href)) throw new Error('That provider file link is not allowed');
  const session = await getSession(id);
  if (!session?.conversationId || chatProviderForStoredConversation(session.conversationId) !== 'chatgpt')
    throw new Error('File links are not supported by this provider');
  const member = (await readEvents(id)).some(event => event.kind === 'assistant_message' && event.messageId === messageId &&
    (event.message.text.includes(href) || event.renderedHtml?.text.includes(href)));
  if (!member || (await getSession(id))?.conversationId !== session.conversationId) throw new Error('This file link is not recorded in this chat');
  return { conversationId: session.conversationId, url: chatProviderConversationUrl('chatgpt', session.conversationId) };
}
