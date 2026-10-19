import type { ControlApiSession, ControlApiSessionDetail, ControlApiSessionList } from '../../shared/control-api.js';
import { chatProviderForStoredConversation } from '../../shared/chat-provider.js';
import type { RemoteSession } from '../../shared/remote.js';
import { listInputs } from '../session/input.js';
import { serveRead } from '../control-reads.js';

/** Opening chats project the outbox's frozen provider, never the mutable default. */
export async function remoteRead(route: string, params: URLSearchParams): Promise<unknown> {
  const view = await serveRead(route, params);
  if (!route.startsWith('/v1/sessions') || route.endsWith('/events') || !view) return view;
  const inputs = await listInputs();
  const session = (row: ControlApiSession): RemoteSession => ({ ...row, provider: chatProviderForStoredConversation(row.conversationId) ??
    inputs.find(input => input.opening && input.sessionId === row.id)?.chatProvider ?? null });
  if (route === '/v1/sessions') { const list = view as ControlApiSessionList; return { ...list, sessions: list.sessions.map(session) }; }
  const detail = view as ControlApiSessionDetail; return { ...detail, session: session(detail.session) };
}
