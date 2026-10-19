import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ARTIFACT_KINDS } from '../../shared/artifact.js';
import { chatProviderForStoredConversation } from '../../shared/chat-provider.js';
import { artifactSummary, createArtifact, listArtifacts, patchArtifact, readArtifact } from '../artifacts/service.js';
import { requestArtifactOpen } from '../artifacts/events.js';
import { beginPresentation, findPresentation, writePresentation } from '../artifacts/presentation.js';
import { presentImage } from '../artifacts/present-image.js';
import { findSessionByConversation, getSession } from '../session/store.js';
import { currentCaller } from './call-context.js';
import { fail, failIdentity, type SurfaceRegistrar } from './kernel.js';
import { mcpProvider } from './provider-context.js';
import { toolDeclaration } from './tool-declarations.js';

const artifactId = z.string().uuid();
const artifactFile = z.object({
  path: z.string().min(1).max(1024),
  text: z.string().max(2 * 1024 * 1024),
  mime_type: z.string().min(1).max(128).optional(),
  language: z.string().min(1).max(64).optional()
}).strict();
const patchOperation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('upsert'), path: z.string().min(1).max(1024), text: z.string().max(2 * 1024 * 1024),
    mime_type: z.string().min(1).max(128).optional(), language: z.string().min(1).max(64).optional() }).strict(),
  z.object({ op: z.literal('delete'), path: z.string().min(1).max(1024) }).strict()
]);

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('begin'), title: z.string().trim().min(1).max(200), kind: z.enum([...ARTIFACT_KINDS, 'html', 'image']) }).strict(),
  z.object({ action: z.literal('image'), presentation_id: artifactId, path: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.literal('fail'), presentation_id: artifactId }).strict(),
  z.object({ action: z.literal('create'), title: z.string().min(1).max(200), kind: z.enum([...ARTIFACT_KINDS, 'html']),
    presentation_id: artifactId.optional(),
    files: z.array(artifactFile).min(1).max(128), entrypoint: z.string().min(1).max(1024).optional() }).strict(),
  z.object({ action: z.literal('read'), artifact_id: artifactId, revision: z.number().int().min(1).optional() }).strict(),
  z.object({ action: z.literal('patch'), artifact_id: artifactId, expected_revision: z.number().int().min(1),
    operations: z.array(patchOperation).max(128).optional(), title: z.string().min(1).max(200).optional(),
    entrypoint: z.string().min(1).max(1024).optional() }).strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('open'), artifact_id: artifactId, revision: z.number().int().min(1).optional() }).strict()
]);

const outputSchema = z.object({ value: z.record(z.string(), z.unknown()) }).strict();

async function ownedSession() {
  const caller = currentCaller();
  const session = caller.sessionId ? await getSession(caller.sessionId)
    : caller.conversationId ? await findSessionByConversation(caller.conversationId, { requireUnique: true }) : null;
  if (!session) return null;
  if (caller.conversationId && session.conversationId !== caller.conversationId) return null;
  const storedProvider = session.conversationId ? chatProviderForStoredConversation(session.conversationId) : null;
  if (storedProvider && storedProvider !== mcpProvider()) return null;
  return session;
}

function json(value: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: { value } };
}

export function registerArtifactTool(reg: SurfaceRegistrar): void {
  const { exposedCaps } = reg;
  if (!exposedCaps.read && !exposedCaps.metadata && !exposedCaps.create && !exposedCaps.edit) return;
  reg.register('artifact', toolDeclaration('artifact', () => ({
    title: 'Interactive canvas and artifacts',
    description: 'Create interactive canvas mockups, HTML prototypes, charts and presentations inline in OneCode. Create, read, patch, list, or open OneCode-owned interactive artifacts in this durable session lineage. Compact & Resume replacement chats inherit the session artifacts; unrelated sessions cannot access them. ' +
      'Artifact identity is stable even when titles match. After creation, every patch must include expected_revision from the latest read/create result; stale revisions are rejected instead of overwriting newer human edits. ' +
      'Use action="begin", title, kind="web" before generating an interactive HTML deliverable to show Generating in chat; pass its presentation_id to action="create" with kind="web", entrypoint="index.html" and files:[{path:"index.html",text:"complete HTML/CSS/JavaScript"}]. The legacy kind="html" is accepted as web. Use image for an approved local PNG/JPEG/WebP. ' +
      'Ready artifacts and images appear inline without opening the side panel. Use open explicitly when presenting an artifact in the workbench. Use fail if generation cannot finish. ' +
      'Interactive web previews need self-contained HTML, CSS and browser JavaScript with artifact-relative files. They have no Node, network or CDN access; compile JSX/TypeScript before supplying preview JavaScript. ' +
      'Artifact file paths are logical artifact-relative paths. The image action reads one approved local file, never a provider URL.',
    inputSchema,
    outputSchema
  })), async input => {
    const session = await ownedSession();
    if (!session) return failIdentity('ARTIFACT_IDENTITY_REQUIRED: OneCode could not prove which local chat owns this artifact call.');
    const provider = mcpProvider();
    try {
      if (input.action === 'begin') return reg.guarded('create', 'artifact', async () => {
        const presentation = await beginPresentation(session.id, { title: input.title, kind: input.kind === 'html' ? 'web' : input.kind, provider });
        return json({ action: 'begin', presentation_id: presentation.id });
      });
      if (input.action === 'image') return reg.guarded('create', 'artifact', () => reg.guarded('read', 'artifact', async () =>
        json({ action: 'image', presentation: await presentImage(session.id, input.presentation_id, provider, reg.ctx.roots, input.path) })));
      if (input.action === 'fail') return reg.guarded('create', 'artifact', async () => {
        const row = (await findPresentation(session.id, input.presentation_id))?.presentation;
        if (!row || row.provider !== provider || row.status !== 'generating') return fail('No matching pending presentation');
        await writePresentation(session.id, { ...row, status: 'failed' }); return json({ action: 'fail' });
      });
      if (input.action === 'create') return reg.guarded('create', 'artifact', async () => {
        const snapshot = await createArtifact({ sessionId: session.id, ...(session.projectId ? { projectId: session.projectId } : {}),
          ...(input.presentation_id ? { presentationId: input.presentation_id } : {}),
          title: input.title, kind: input.kind === 'html' ? 'web' : input.kind, entrypoint: input.entrypoint, source: 'model',
          origin: { provider, ...(session.conversationId ? { conversationId: session.conversationId } : {}) },
          files: input.files.map(file => ({ path: file.path, text: file.text, ...(file.mime_type ? { mimeType: file.mime_type } : {}),
            ...(file.language ? { language: file.language } : {}) })) });
        return json({ action: 'create', artifact: artifactSummary(snapshot.artifact), revision: snapshot.revision.revision });
      });
      if (input.action === 'patch') return reg.guarded('edit', 'artifact', async () => {
        const snapshot = await patchArtifact({ sessionId: session.id, artifactId: input.artifact_id, expectedRevision: input.expected_revision,
          source: 'model', ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.entrypoint !== undefined ? { entrypoint: input.entrypoint } : {}),
          ...(input.operations ? { operations: input.operations.map(operation => operation.op === 'delete' ? operation : ({
            op: 'upsert' as const, path: operation.path, text: operation.text, ...(operation.mime_type ? { mimeType: operation.mime_type } : {}),
            ...(operation.language ? { language: operation.language } : {})
          })) } : {}) });
        return json({ action: 'patch', artifact: artifactSummary(snapshot.artifact), revision: snapshot.revision.revision });
      });
      if (input.action === 'read') return reg.guarded('read', 'artifact', async () => {
        const snapshot = await readArtifact(session.id, input.artifact_id, input.revision);
        return snapshot ? json({ action: 'read', snapshot }) : fail('ARTIFACT_NOT_FOUND: no retained artifact/revision matches that identity.');
      });
      if (input.action === 'list') return reg.guarded('metadata', 'artifact', async () =>
        json({ action: 'list', artifacts: await listArtifacts(session.id) }));
      return reg.guarded('metadata', 'artifact', async () => {
        const snapshot = await readArtifact(session.id, input.artifact_id, input.revision);
        if (!snapshot) return fail('ARTIFACT_NOT_FOUND: no retained artifact matches that identity.');
        await writePresentation(session.id, { id: snapshot.artifact.id, title: snapshot.artifact.title, kind: snapshot.artifact.kind,
          provider, status: 'ready', artifactId: snapshot.artifact.id, revision: snapshot.revision.revision, openId: randomUUID() });
        requestArtifactOpen({ sessionId: session.id, artifactId: input.artifact_id, revision: snapshot.revision.revision });
        return json({ action: 'open', artifact: artifactSummary(snapshot.artifact), revision: snapshot.revision.revision });
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'Artifact operation failed');
    }
  });
}
