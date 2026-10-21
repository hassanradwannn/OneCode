import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ARTIFACT_KINDS } from '../../shared/artifact.js';
import { chatProviderForStoredConversation } from '../../shared/chat-provider.js';
import { artifactSummary, createArtifact, listArtifacts, patchArtifact, readArtifact } from '../artifacts/service.js';
import { requestArtifactOpen } from '../artifacts/events.js';
import { beginPresentation, findPresentation, writePresentation } from '../artifacts/presentation.js';
import { presentImage } from '../artifacts/present-image.js';
import { presentVideo } from '../artifacts/present-video.js';
import { findSessionByConversation, getSession } from '../session/store.js';
import { currentCaller } from './call-context.js';
import { fail, failIdentity, type SurfaceRegistrar } from './kernel.js';
import { mcpProvider } from './provider-context.js';
import { toolDeclaration } from './tool-declarations.js';

const artifactId = z.string().uuid().describe('Exact UUID returned by begin/create/read. Never invent an ID or use a conversation ID.');
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

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('begin'), title: z.string().trim().min(1).max(200), kind: z.enum([...ARTIFACT_KINDS, 'html', 'image', 'video']) }).strict(),
  z.object({ action: z.literal('image'), presentation_id: artifactId, path: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.literal('video'), presentation_id: artifactId, path: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.literal('fail'), presentation_id: artifactId }).strict(),
  z.object({ action: z.literal('create'), title: z.string().min(1).max(200).optional(), kind: z.enum([...ARTIFACT_KINDS, 'html']).optional(),
    presentation_id: artifactId.optional(),
    files: z.array(artifactFile).min(1).max(128), entrypoint: z.string().min(1).max(1024).optional() }).strict()
    .refine(input => Boolean(input.title || input.presentation_id), { path: ['title'], message: 'Provide title, or presentation_id from a successful begin to inherit its title.' })
    .refine(input => Boolean(input.kind || input.presentation_id), { path: ['kind'], message: 'Provide kind, or presentation_id from a successful begin to inherit its kind.' }),
  z.object({ action: z.literal('read'), artifact_id: artifactId, revision: z.number().int().min(1).optional() }).strict(),
  z.object({ action: z.literal('patch'), artifact_id: artifactId, expected_revision: z.number().int().min(1),
    operations: z.array(patchOperation).max(128).optional(), title: z.string().min(1).max(200).optional(),
    entrypoint: z.string().min(1).max(1024).optional() }).strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('present'), artifact_id: artifactId, revision: z.number().int().min(1).optional() }).strict(),
  z.object({ action: z.literal('open'), artifact_id: artifactId, revision: z.number().int().min(1).optional() }).strict()
]);

// Publish one object root with discoverable fields. Some native clients lose
// fields hidden solely inside a union; the original action validator still owns
// required/forbidden arguments and runs before any handler mutation.
const inputSchema = z.object({
  action: z.enum(['begin', 'image', 'video', 'fail', 'create', 'read', 'patch', 'list', 'present', 'open']),
  title: z.string().min(1).max(200).optional().describe('begin/create title; create may inherit from its exact pending presentation_id.'),
  kind: z.enum([...ARTIFACT_KINDS, 'html', 'image', 'video']).optional().describe('web for interactive HTML; image/video are begin-only.'),
  presentation_id: artifactId.optional().describe('create/image/video/fail: exact UUID from the successful begin result.'),
  artifact_id: artifactId.optional().describe('read/patch/present/open: exact artifact.id from create/list/read.'),
  files: z.array(artifactFile).min(1).max(128).optional().describe('create only: complete files, never a patch operation.'),
  entrypoint: z.string().min(1).max(1024).optional(),
  path: z.string().min(1).max(4096).optional().describe('image/video: approved local file path; MP4/WebM videos up to 128 MiB.'),
  revision: z.number().int().min(1).optional().describe('read/present/open: retained revision; omit for latest.'),
  expected_revision: z.number().int().min(1).optional().describe('patch requires the latest revision returned by read/create/patch.'),
  operations: z.array(patchOperation).max(128).optional().describe('patch only: [{op:"upsert",path,text}] or [{op:"delete",path}].')
}).strict().pipe(actionSchema);

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
      'For interactive HTML, begin with title and kind="web", then create with its presentation_id, kind="web", entrypoint="index.html", files:[{path:"index.html",text:"complete HTML/CSS/JavaScript"}]. Legacy html means web. For locally generated photos or videos, begin with kind="image" or "video", then use that action, exact presentation_id and approved local path (PNG/JPEG/WebP; MP4/WebM up to 128 MiB). Media appears inline with playback in desktop and Remote. ' +
      'create can inherit title from its exact pending presentation_id. Keep the begin result and reuse its UUID verbatim. Check isError after every call; never claim an artifact was created after an error. Nested exec calls inherit routing: omit conversation_id/session_key. ' +
      'Ready artifacts and patched revisions appear inline at the latest reply. Use present to bring the same artifact back to the bottom of chat; use open only when the user requests the workbench side panel. Never recreate an artifact to show it again. Use fail if generation cannot finish. ' +
      'Interactive web previews need self-contained HTML, CSS and browser JavaScript with artifact-relative files. They have no Node, network or CDN access; compile JSX/TypeScript before supplying preview JavaScript. ' +
      'Artifact file paths are logical artifact-relative paths. Media actions read an approved completed local file, never a provider URL.',
    inputSchema,
    outputSchema
  })), async input => {
    const session = await ownedSession();
    if (!session) return failIdentity('ARTIFACT_IDENTITY_REQUIRED: OneCode could not prove which local chat owns this artifact call.');
    const provider = mcpProvider();
    try {
      if (input.action === 'begin') return reg.guarded('create', 'artifact', async () => {
        const presentation = await beginPresentation(session.id, { title: input.title, kind: input.kind === 'html' ? 'web' : input.kind, provider });
        return json({ action: 'begin', presentation_id: presentation.id, kind: presentation.kind,
          next_action: presentation.kind === 'image' || presentation.kind === 'video' ? presentation.kind : 'create',
          instruction: 'Keep this presentation_id. Complete this presentation next; do not call begin again for this deliverable.' });
      });
      if (input.action === 'image') return reg.guarded('create', 'artifact', () => reg.guarded('read', 'artifact', async () =>
        json({ action: 'image', presentation: await presentImage(session.id, input.presentation_id, provider, reg.ctx.roots, input.path) })));
      if (input.action === 'video') return reg.guarded('create', 'artifact', () => reg.guarded('read', 'artifact', async () =>
        json({ action: 'video', presentation: await presentVideo(session.id, input.presentation_id, provider, reg.ctx.roots, input.path) })));
      if (input.action === 'fail') return reg.guarded('create', 'artifact', async () => {
        const row = (await findPresentation(session.id, input.presentation_id))?.presentation;
        if (!row || row.provider !== provider || row.status !== 'generating') return fail('No matching pending presentation');
        await writePresentation(session.id, { ...row, status: 'failed' }); return json({ action: 'fail' });
      });
      if (input.action === 'create') return reg.guarded('create', 'artifact', async () => {
        const pending = input.presentation_id ? (await findPresentation(session.id, input.presentation_id))?.presentation : null;
        if (input.presentation_id && (!pending || pending.provider !== provider || pending.status !== 'generating'))
          return fail('ARTIFACT_PRESENTATION_NOT_PENDING: use the exact presentation_id returned by begin in this session. No artifact was created.');
        const title = input.title ?? pending?.title;
        if (!title) return fail('ARTIFACT_TITLE_REQUIRED: provide title or the exact pending presentation_id from begin. No artifact was created.');
        const kind = input.kind === 'html' ? 'web' : input.kind ?? pending?.kind;
        if (!kind || kind === 'image' || kind === 'video') return fail('ARTIFACT_KIND_REQUIRED: provide an artifact kind or pending web presentation_id. Use image/video actions for local media. No artifact was created.');
        const snapshot = await createArtifact({ sessionId: session.id, ...(session.projectId ? { projectId: session.projectId } : {}),
          ...(input.presentation_id ? { presentationId: input.presentation_id } : {}),
          title, kind, entrypoint: input.entrypoint, source: 'model',
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
        if (input.action === 'open') requestArtifactOpen({ sessionId: session.id, artifactId: input.artifact_id, revision: snapshot.revision.revision });
        return json({ action: input.action, artifact: artifactSummary(snapshot.artifact), revision: snapshot.revision.revision });
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'Artifact operation failed');
    }
  });
}
