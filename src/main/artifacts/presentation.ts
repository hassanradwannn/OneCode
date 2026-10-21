import { randomUUID } from 'node:crypto';
import type { ArtifactOrigin, ArtifactPresentation, ArtifactSnapshot } from '../../shared/artifact.js';
import { chatProviderForStoredConversation } from '../../shared/chat-provider.js';
import { appendEvent, getSession, readEvents } from '../session/store.js';

const pending = new Map<string, Promise<unknown>>();
async function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const result = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  pending.set(key, result);
  try { return await result; } finally { if (pending.get(key) === result) pending.delete(key); }
}
export async function findPresentation(sessionId: string, id: string) {
  return (await readEvents(sessionId)).reverse().find(event => event.kind === 'progress' && event.presentation?.id === id) as
    Extract<Awaited<ReturnType<typeof readEvents>>[number], { kind: 'progress' }> | undefined;
}
export async function writePresentation(sessionId: string, value: ArtifactPresentation, nativeOrigin?: ArtifactOrigin): Promise<void> {
  await serial(`${sessionId}:${value.id}`, async () => {
    const session = await getSession(sessionId);
    if (!session || session.conversationId && chatProviderForStoredConversation(session.conversationId) !== value.provider) throw new Error('Presentation does not match its session provider');
    const previous = await findPresentation(sessionId, value.id);
    if (previous?.presentation?.provider !== undefined && previous.presentation.provider !== value.provider) throw new Error('Presentation provider changed');
    if (previous?.presentation?.status === 'ready' && value.status !== 'ready') throw new Error('A completed presentation cannot return to generating');
    if (previous?.presentation?.status === 'failed' && value.status !== 'failed') throw new Error('A failed presentation is terminal; begin another generation');
    if (previous?.presentation?.status === 'ready' && previous.presentation.asset && previous.presentation.asset.id !== value.asset?.id)
      throw new Error('Completed media cannot be replaced by another completion');
    if (previous && JSON.stringify(previous.presentation) === JSON.stringify(value)) return;
    const sourceMessage=nativeOrigin?.messageId?(await readEvents(sessionId)).find(event=>event.kind==='assistant_message'&&event.messageId===nativeOrigin.messageId):undefined;
    const refreshed = !nativeOrigin?.messageId && previous?.presentation?.status === 'ready' && value.status === 'ready' &&
      (previous.presentation.revision !== value.revision || previous.presentation.openId !== value.openId);
    const time = refreshed ? Date.now() : previous?.time ?? sourceMessage?.time ?? Date.now();
    const turnId=refreshed ? session.activeTurnId : previous?.turnId??sourceMessage?.turnId??nativeOrigin?.turnId??(!nativeOrigin?.messageId?session.activeTurnId:undefined);
    const message = value.status === 'generating' ? 'Generating' : value.status === 'failed' ? 'Generation failed' : value.title;
    await appendEvent(sessionId, { kind: 'progress', source: 'app', time, progressId: `presentation:${value.id}`,
      ...(previous && !refreshed ? { origin: previous.origin ?? previous.seq } : {}),
      ...(turnId ? { turnId } : {}),
      presentation: value, message: { text: message, chars: message.length, truncated: false } });
  });
  const { notifyChanged } = await import('../session/recorder.js'); notifyChanged(sessionId);
}
export async function beginPresentation(sessionId: string, value: Pick<ArtifactPresentation, 'title' | 'kind' | 'provider'>): Promise<ArtifactPresentation> {
  const row: ArtifactPresentation = { ...value, id: randomUUID(), status: 'generating' };
  await writePresentation(sessionId, row); return row;
}
export async function requirePendingPresentation(sessionId: string, id: string, kind: ArtifactPresentation['kind'], provider: ArtifactPresentation['provider']): Promise<ArtifactPresentation> {
  const row = (await findPresentation(sessionId, id))?.presentation;
  if (!row || row.status !== 'generating' || row.kind !== kind || row.provider !== provider) throw new Error('No matching pending presentation exists in this session');
  return row;
}
export async function presentArtifact(snapshot: ArtifactSnapshot, presentationId = snapshot.artifact.id): Promise<void> {
  const artifact = snapshot.artifact;
  await writePresentation(artifact.sessionId, { id: presentationId, title: artifact.title, kind: artifact.kind, provider: artifact.origin.provider,
    status: 'ready', artifactId: artifact.id, revision: snapshot.revision.revision },
    snapshot.revision.source === 'provider' ? artifact.origin : undefined);
}
