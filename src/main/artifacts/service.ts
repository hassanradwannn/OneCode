import { createHash, randomUUID } from 'node:crypto';
import { chatProviderForStoredConversation, type ChatProvider } from '../../shared/chat-provider.js';
import { admitNativeArtifactSnapshot } from '../../shared/native-output.js';
import type {
  Artifact, ArtifactCapabilities, ArtifactFile, ArtifactKind, ArtifactOrigin, ArtifactPatchOperation,
  ArtifactRevision, ArtifactRevisionSource, ArtifactSnapshot, ArtifactSummary
} from '../../shared/artifact.js';
import { getSession } from '../session/store.js';
import { createArtifactRecord, listArtifactRecords, readArtifactRecord, updateArtifactRecord } from './store.js';
import { findPresentation, presentArtifact, requirePendingPresentation, writePresentation } from './presentation.js';

const MAX_FILES = 128;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REVISION_BYTES = 8 * 1024 * 1024;
const MAX_REVISIONS = 64;

export interface CreateArtifactInput {
  presentationId?: string;
  sessionId: string;
  projectId?: string;
  title: string;
  kind: ArtifactKind;
  origin: ArtifactOrigin;
  entrypoint?: string;
  files: Array<{ path: string; text: string; mimeType?: string; language?: string }>;
  source?: ArtifactRevisionSource;
  messageId?: string;
}

export interface PatchArtifactInput {
  sessionId: string;
  artifactId: string;
  expectedRevision: number;
  operations?: ArtifactPatchOperation[];
  title?: string;
  entrypoint?: string;
  source: ArtifactRevisionSource;
  messageId?: string;
}

export interface ImportProviderArtifactRevisionInput {
  sessionId: string;
  provider: ChatProvider;
  conversationId: string;
  turnId?: string;
  messageId: string;
  providerArtifactId: string;
  providerRevisionId: string;
  providerParentRevisionId?: string;
  title?: string;
  kind: ArtifactKind;
  entrypoint?: string;
  files: Array<{ path: string; text: string; mimeType?: string; language?: string }>;
  createdAt?: number;
}

export interface ImportProviderArtifactRevisionResult {
  snapshot: ArtifactSnapshot;
  changed: boolean;
}

type NativeSnapshotInput = Omit<ImportProviderArtifactRevisionInput, 'providerArtifactId' | 'providerRevisionId' | 'providerParentRevisionId'> & {nativeSurface: string};
function nativeSnapshotId(input: Pick<NativeSnapshotInput,'sessionId'|'provider'|'conversationId'|'messageId'|'nativeSurface'>): string {
  const hex=createHash('sha256').update(JSON.stringify([input.sessionId,input.provider,input.conversationId,input.messageId,input.nativeSurface])).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export async function beginNativeArtifactSnapshot(input: Omit<NativeSnapshotInput,'files'|'entrypoint'>): Promise<boolean> {
  if(!admitNativeArtifactSnapshot({conversationId:input.conversationId,provider:input.provider,messageId:input.messageId,surface:input.nativeSurface}))throw new Error('Native artifact snapshot identity is invalid');
  const session=await getSession(input.sessionId);
  if(!session||![session.conversationId,...session.chatIds].includes(input.conversationId))throw new Error('Native artifact snapshot conversation does not belong to this session');
  const id=nativeSnapshotId(input);if(await findPresentation(input.sessionId,id))return false;
  await writePresentation(input.sessionId,{id,title:input.title?.trim().slice(0,200)||'Canvas',kind:input.kind,provider:input.provider,status:'generating'},
    {provider:input.provider,conversationId:input.conversationId,messageId:input.messageId,...(input.turnId?{turnId:input.turnId}:{})});return true;
}
export async function failNativeArtifactSnapshot(input: Omit<NativeSnapshotInput,'files'|'entrypoint'>): Promise<boolean> {
  await beginNativeArtifactSnapshot(input);
  const id=nativeSnapshotId(input),previous=(await findPresentation(input.sessionId,id))?.presentation;
  if(!previous||previous.status!=='generating')return false;
  await writePresentation(input.sessionId,{...previous,status:'failed'});return true;
}

/** Local immutable source revisions for a native response-scoped surface. No provider ids are fabricated. */
export async function importProviderArtifactSnapshot(input: NativeSnapshotInput): Promise<ImportProviderArtifactRevisionResult> {
  if (!admitNativeArtifactSnapshot({conversationId:input.conversationId,provider:input.provider,messageId:input.messageId,surface:input.nativeSurface})) {
    throw new Error('Native artifact snapshot identity is invalid');
  }
  const session = await getSession(input.sessionId);
  if (!session || ![session.conversationId,...session.chatIds].includes(input.conversationId) || (session.conversationId && chatProviderForStoredConversation(session.conversationId) !== input.provider)) throw new Error('Native artifact snapshot session does not match its provider');
  const files = filesOf(input.files), entrypoint = normalizePath(input.entrypoint ?? files[0]!.path);
  if (!files.some(file=>file.path===entrypoint)) throw new Error('Artifact entrypoint must name one retained file');
  const records = (await listArtifactRecords(input.sessionId)).filter(record=>record.artifact.origin.provider===input.provider &&
    record.artifact.origin.conversationId===input.conversationId && record.artifact.origin.messageId===input.messageId && record.artifact.origin.nativeSurface===input.nativeSurface);
  if(records.length>1)throw new Error('Native artifact snapshot identity is ambiguous');
  const current=records[0];
  if(!current){
    await beginNativeArtifactSnapshot(input);
    const snapshot=await createArtifact({presentationId:nativeSnapshotId(input),sessionId:input.sessionId,...(session.projectId?{projectId:session.projectId}:{}),title:input.title?.trim().slice(0,200)||'Canvas',kind:input.kind,entrypoint,files:input.files,source:'provider',messageId:input.messageId,
      origin:{provider:input.provider,conversationId:input.conversationId,messageId:input.messageId,nativeSurface:input.nativeSurface,...(input.turnId?{turnId:input.turnId}:{})}});
    return{snapshot,changed:true};
  }
  if(current.artifact.kind!==input.kind)throw new Error('Native artifact snapshot kind changed');
  const head=current.revisions.find(revision=>revision.revision===current.artifact.headRevision);
  if(!head)throw new Error('Native artifact snapshot head is unavailable');
  // An identical observed file set is a replay, even after reload. Revision numbers are local.
  const replay=current.revisions.find(revision=>revision.source==='provider'&&revision.files.length===files.length&&files.every((file,index)=>{const prior=revision.files[index];return prior?.path===file.path&&prior.sha256===file.sha256&&prior.mimeType===file.mimeType&&prior.language===file.language}));
  if(replay)return{snapshot:{artifact:current.artifact,revision:replay},changed:false};
  if(head.source!=='provider')throw new Error('Native Canvas source cannot replace local edits');
  const snapshot=await patchArtifact({sessionId:input.sessionId,artifactId:current.artifact.id,expectedRevision:current.artifact.headRevision,source:'provider',messageId:input.messageId,entrypoint,
    operations:[...head.files.filter(file=>!files.some(next=>next.path===file.path)).map(file=>({op:'delete' as const,path:file.path})),...input.files.map(file=>({op:'upsert' as const,...file}))]});
  return{snapshot,changed:true};
}

function normalizePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('Artifact file paths must be relative and cannot contain empty, . or .. segments');
  }
  if (normalized.length > 1024) throw new Error('Artifact file path is too long');
  return normalized;
}

function fileOf(input: { path: string; text: string; mimeType?: string; language?: string }): ArtifactFile {
  const path = normalizePath(input.path);
  const bytes = Buffer.byteLength(input.text, 'utf8');
  if (bytes > MAX_FILE_BYTES) throw new Error(`Artifact file ${path} is too large`);
  return { path, text: input.text, bytes, sha256: createHash('sha256').update(input.text, 'utf8').digest('hex'),
    ...(input.mimeType ? { mimeType: input.mimeType.slice(0, 128) } : {}),
    ...(input.language ? { language: input.language.slice(0, 64) } : {}) };
}

function filesOf(inputs: Array<{ path: string; text: string; mimeType?: string; language?: string }>): ArtifactFile[] {
  if (!inputs.length || inputs.length > MAX_FILES) throw new Error(`Artifacts must contain between 1 and ${MAX_FILES} files`);
  const files = inputs.map(fileOf), seen = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    if (seen.has(file.path)) throw new Error(`Artifact file path is duplicated: ${file.path}`);
    seen.add(file.path); bytes += file.bytes;
  }
  if (bytes > MAX_REVISION_BYTES) throw new Error('Artifact revision is too large');
  return files;
}

function capabilities(kind: ArtifactKind): ArtifactCapabilities {
  return { preview: ['web', 'markdown', 'diagram'].includes(kind), edit: true, export: true, providerWriteback: false };
}

export function artifactSummary(artifact: Artifact): ArtifactSummary {
  return { id: artifact.id, sessionId: artifact.sessionId, ...(artifact.projectId ? { projectId: artifact.projectId } : {}),
    title: artifact.title, kind: artifact.kind, headRevision: artifact.headRevision, retainedFromRevision: artifact.retainedFromRevision,
    ...(artifact.entrypoint ? { entrypoint: artifact.entrypoint } : {}), updatedAt: artifact.updatedAt, origin: artifact.origin,
    capabilities: artifact.capabilities };
}

export async function createArtifact(input: CreateArtifactInput): Promise<ArtifactSnapshot> {
  const session = await getSession(input.sessionId);
  if (!session) throw new Error('Session was not found');
  if (session.conversationId && chatProviderForStoredConversation(session.conversationId) !== input.origin.provider)
    throw new Error('Artifact provider does not match the session provider');
  if (input.projectId && session.projectId !== input.projectId) throw new Error('Artifact project does not match the session project');
  const title = input.title.trim();
  if (!title || title.length > 200) throw new Error('Artifact title must be between 1 and 200 characters');
  const files = filesOf(input.files);
  const entrypoint = normalizePath(input.entrypoint ?? files[0]!.path);
  if (!files.some(file => file.path === entrypoint)) throw new Error('Artifact entrypoint must name one retained file');
  if (input.presentationId) await requirePendingPresentation(input.sessionId, input.presentationId, input.kind, input.origin.provider);
  const now = Date.now(), id = input.presentationId ?? randomUUID();
  const artifact: Artifact = { id, sessionId: input.sessionId, ...(input.projectId ? { projectId: input.projectId } : {}),
    title, kind: input.kind, origin: input.origin, headRevision: 1, retainedFromRevision: 1, entrypoint, createdAt: now, updatedAt: now,
    capabilities: capabilities(input.kind) };
  const revision: ArtifactRevision = { artifactId: id, revision: 1, source: input.source ?? 'model', createdAt: now, files,
    ...(input.messageId ? { messageId: input.messageId } : {}) };
  await createArtifactRecord({ artifact, revisions: [revision] });
  await presentArtifact({ artifact, revision });
  return { artifact, revision };
}

/**
 * Imports one immutable provider-native artifact revision.
 *
 * Provider ids are retained as evidence while OneCode keeps its own local UUID/revision sequence.
 * Replaying the exact provider revision is idempotent. Reusing a provider revision id for changed
 * bytes, another message, or another parent fails closed instead of silently rewriting history.
 */
export async function importProviderArtifactRevision(
  input: ImportProviderArtifactRevisionInput
): Promise<ImportProviderArtifactRevisionResult> {
  const providerIdentity = (value: string, label: string): string => {
    const trimmed = value.trim();
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(trimmed)) throw new Error('Invalid provider artifact ' + label);
    return trimmed;
  };
  const sameFiles = (left: readonly ArtifactFile[], right: readonly ArtifactFile[]): boolean =>
    left.length === right.length && left.every((file, index) => {
      const other = right[index];
      return !!other && file.path === other.path && file.sha256 === other.sha256 && file.bytes === other.bytes &&
        file.mimeType === other.mimeType && file.language === other.language;
    });
  const session = await getSession(input.sessionId);
  if (!session) throw new Error('Session was not found');
  if (chatProviderForStoredConversation(input.conversationId) !== input.provider) {
    throw new Error('Provider artifact conversation does not match its provider');
  }
  if (session.conversationId && chatProviderForStoredConversation(session.conversationId) !== input.provider) {
    throw new Error('Provider artifact does not match the session provider');
  }
  const providerArtifactId = providerIdentity(input.providerArtifactId, 'id');
  const providerRevisionId = providerIdentity(input.providerRevisionId, 'revision id');
  const providerParentRevisionId = input.providerParentRevisionId
    ? providerIdentity(input.providerParentRevisionId, 'parent revision id') : undefined;
  if (!input.messageId || input.messageId.length > 200) throw new Error('Provider artifact message id is invalid');
  const files = filesOf(input.files);
  const entrypoint = normalizePath(input.entrypoint ?? files[0]!.path);
  if (!files.some(file => file.path === entrypoint)) throw new Error('Artifact entrypoint must name one retained file');
  const suppliedTitle = input.title?.trim();
  if (suppliedTitle && suppliedTitle.length > 200) throw new Error('Artifact title is too long');
  const createdAt = Number.isFinite(input.createdAt) && (input.createdAt ?? 0) > 0 ? Math.round(input.createdAt!) : Date.now();

  const records = (await listArtifactRecords(input.sessionId)).filter(record =>
    record.artifact.origin.provider === input.provider &&
    record.artifact.origin.conversationId === input.conversationId &&
    record.artifact.origin.providerArtifactId === providerArtifactId);
  if (records.length > 1) throw new Error('Provider artifact identity is ambiguous in local storage');
  const current = records[0];
  if (!current) {
    const id = randomUUID();
    const title = suppliedTitle || providerArtifactId;
    const artifact: Artifact = {
      id,
      sessionId: input.sessionId,
      ...(session.projectId ? { projectId: session.projectId } : {}),
      title,
      kind: input.kind,
      origin: { provider: input.provider, conversationId: input.conversationId,
        ...(input.turnId ? { turnId: input.turnId } : {}), messageId: input.messageId, providerArtifactId },
      headRevision: 1,
      retainedFromRevision: 1,
      entrypoint,
      createdAt,
      updatedAt: createdAt,
      capabilities: capabilities(input.kind)
    };
    const revision: ArtifactRevision = { artifactId: id, revision: 1, source: 'provider', createdAt, files,
      messageId: input.messageId, providerRevisionId,
      ...(providerParentRevisionId ? { providerParentRevisionId } : {}) };
    await createArtifactRecord({ artifact, revisions: [revision] });
    await presentArtifact({ artifact, revision });
    return { snapshot: { artifact, revision }, changed: true };
  }
  if (current.artifact.kind !== input.kind) throw new Error('Provider artifact kind changed for the same native identity');
  const already = current.revisions.find(revision => revision.providerRevisionId === providerRevisionId);
  if (already) {
    if (already.messageId !== input.messageId || already.providerParentRevisionId !== providerParentRevisionId || !sameFiles(already.files, files)) {
      throw new Error('Provider artifact revision changed after it was imported');
    }
    return { snapshot: { artifact: current.artifact, revision: already }, changed: false };
  }
  const head = current.revisions.find(revision => revision.revision === current.artifact.headRevision);
  if (!head) throw new Error('Artifact head revision is unavailable');
  if (providerParentRevisionId && head.providerRevisionId !== providerParentRevisionId) {
    throw new Error('Provider artifact parent revision does not match the retained head');
  }
  const updated = await updateArtifactRecord(input.sessionId, current.artifact.id, current.artifact.headRevision, record => {
    const revisionNumber = record.artifact.headRevision + 1;
    const revision: ArtifactRevision = { artifactId: record.artifact.id, revision: revisionNumber,
      parentRevision: record.artifact.headRevision, source: 'provider', createdAt, files, messageId: input.messageId,
      providerRevisionId, ...(providerParentRevisionId ? { providerParentRevisionId } : {}) };
    const revisions = [...record.revisions, revision].slice(-MAX_REVISIONS);
    return { artifact: { ...record.artifact, title: suppliedTitle || record.artifact.title, entrypoint,
      headRevision: revisionNumber, retainedFromRevision: revisions[0]!.revision, updatedAt: createdAt }, revisions };
  });
  const revision = updated.revisions.find(row => row.providerRevisionId === providerRevisionId)!;
  await presentArtifact({ artifact: updated.artifact, revision });
  return { snapshot: { artifact: updated.artifact, revision }, changed: true };
}

export async function readArtifact(sessionId: string, artifactId: string, revision?: number): Promise<ArtifactSnapshot | null> {
  const record = await readArtifactRecord(sessionId, artifactId);
  if (!record) return null;
  const selected = revision === undefined ? record.revisions.find(row => row.revision === record.artifact.headRevision)
    : record.revisions.find(row => row.revision === revision);
  return selected ? { artifact: record.artifact, revision: selected } : null;
}

export async function listArtifacts(sessionId: string): Promise<ArtifactSummary[]> {
  const records = await listArtifactRecords(sessionId);
  return records.map(record => artifactSummary(record.artifact)).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export async function patchArtifact(input: PatchArtifactInput): Promise<ArtifactSnapshot> {
  const operations = input.operations ?? [];
  if (!operations.length && input.title === undefined && input.entrypoint === undefined) throw new Error('Artifact patch is empty');
  const updated = await updateArtifactRecord(input.sessionId, input.artifactId, input.expectedRevision, current => {
    const head = current.revisions.find(row => row.revision === current.artifact.headRevision);
    if (!head) throw new Error('Artifact head revision is unavailable');
    const files = new Map(head.files.map(file => [file.path, file]));
    for (const operation of operations) {
      const path = normalizePath(operation.path);
      if (operation.op === 'delete') files.delete(path);
      else files.set(path, fileOf({ ...operation, path }));
    }
    const nextFiles = filesOf([...files.values()].map(file => ({ path: file.path, text: file.text, mimeType: file.mimeType, language: file.language })));
    const title = input.title === undefined ? current.artifact.title : input.title.trim();
    if (!title || title.length > 200) throw new Error('Artifact title must be between 1 and 200 characters');
    const entrypoint = normalizePath(input.entrypoint ?? (files.has(current.artifact.entrypoint ?? '') ? current.artifact.entrypoint! : nextFiles[0]!.path));
    if (!nextFiles.some(file => file.path === entrypoint)) throw new Error('Artifact entrypoint must name one retained file');
    const now = Date.now(), revisionNumber = current.artifact.headRevision + 1;
    const revision: ArtifactRevision = { artifactId: current.artifact.id, revision: revisionNumber, parentRevision: current.artifact.headRevision,
      source: input.source, createdAt: now, files: nextFiles, ...(input.messageId ? { messageId: input.messageId } : {}) };
    const revisions = [...current.revisions, revision].slice(-MAX_REVISIONS);
    return { artifact: { ...current.artifact, title, entrypoint, headRevision: revisionNumber, retainedFromRevision: revisions[0]!.revision, updatedAt: now }, revisions };
  });
  const revision = updated.revisions.find(row => row.revision === updated.artifact.headRevision)!;
  await presentArtifact({ artifact: updated.artifact, revision });
  return { artifact: updated.artifact, revision };
}

export function artifactOrigin(provider: ChatProvider, options: Omit<ArtifactOrigin, 'provider'> = {}): ArtifactOrigin {
  return { provider, ...options };
}
