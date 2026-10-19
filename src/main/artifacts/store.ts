import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Artifact, ArtifactRevision } from '../../shared/artifact.js';
import { getSession, sessionsRoot, withSessionMutationFence } from '../session/store.js';

export interface ArtifactRecord {
  artifact: Artifact;
  revisions: ArtifactRevision[];
}

const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID = /^[0-9a-z-]{8,64}$/i;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

export class ArtifactRevisionConflictError extends Error {
  constructor(public readonly expectedRevision: number, public readonly actualRevision: number) {
    super(`Artifact changed from revision ${expectedRevision} to ${actualRevision}. Reload it before applying this edit.`);
    this.name = 'ArtifactRevisionConflictError';
  }
}

function assertIds(sessionId: string, artifactId?: string): void {
  if (!SESSION_ID.test(sessionId)) throw new Error('Invalid session id');
  if (artifactId !== undefined && !ARTIFACT_ID.test(artifactId)) throw new Error('Invalid artifact id');
}

function artifactsDir(sessionId: string): string {
  assertIds(sessionId);
  const root = sessionsRoot();
  if (!root) throw new Error('Session storage is unavailable');
  return path.join(root, sessionId, 'artifacts');
}

function artifactPath(sessionId: string, artifactId: string): string {
  assertIds(sessionId, artifactId);
  return path.join(artifactsDir(sessionId), `${artifactId}.json`);
}

function isRecord(value: unknown, artifactId?: string): value is ArtifactRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ArtifactRecord>;
  if (!record.artifact || !Array.isArray(record.revisions) || !record.revisions.length) return false;
  if (!ARTIFACT_ID.test(record.artifact.id) || record.artifact.id !== (artifactId ?? record.artifact.id)) return false;
  const head = record.revisions.find(revision => revision.revision === record.artifact!.headRevision);
  return !!head && head.artifactId === record.artifact.id;
}

async function readRecordFile(file: string, artifactId?: string): Promise<ArtifactRecord | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) return null;
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    return isRecord(value, artifactId) ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeRecordAtomic(file: string, record: ArtifactRecord, createOnly = false): Promise<void> {
  const encoded = JSON.stringify(record);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_RECORD_BYTES) throw new Error('Artifact history is too large to retain safely');
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (createOnly) {
    try { await fs.lstat(file); throw new Error('Artifact already exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await fs.open(temporary, 'wx'); created = true;
    try { await handle.writeFile(encoded, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    if (createOnly) {
      try { await fs.lstat(file); throw new Error('Artifact already exists'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (createOnly) {
      try { await fs.link(temporary, file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Artifact already exists');
        await fs.copyFile(temporary, file, constants.COPYFILE_EXCL);
      }
      await fs.rm(temporary, { force: true }); created = false;
    } else { await fs.rename(temporary, file); created = false; }
  } finally {
    if (created) await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readArtifactRecord(sessionId: string, artifactId: string): Promise<ArtifactRecord | null> {
  assertIds(sessionId, artifactId);
  if (!await getSession(sessionId)) return null;
  return readRecordFile(artifactPath(sessionId, artifactId), artifactId);
}

export async function listArtifactRecords(sessionId: string): Promise<ArtifactRecord[]> {
  assertIds(sessionId);
  if (!await getSession(sessionId)) return [];
  let entries;
  try { entries = await fs.readdir(artifactsDir(sessionId), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const records = await Promise.all(entries
    .filter(entry => entry.isFile() && ARTIFACT_ID.test(entry.name.replace(/\.json$/i, '')) && entry.name.endsWith('.json'))
    .map(entry => readRecordFile(path.join(artifactsDir(sessionId), entry.name), entry.name.slice(0, -5))));
  return records.filter((record): record is ArtifactRecord => record !== null);
}

export async function createArtifactRecord(record: ArtifactRecord): Promise<ArtifactRecord> {
  assertIds(record.artifact.sessionId, record.artifact.id);
  return withSessionMutationFence(record.artifact.sessionId, async () => {
    await writeRecordAtomic(artifactPath(record.artifact.sessionId, record.artifact.id), record, true);
    return record;
  });
}

export async function updateArtifactRecord(
  sessionId: string, artifactId: string, expectedRevision: number,
  update: (current: ArtifactRecord) => ArtifactRecord
): Promise<ArtifactRecord> {
  assertIds(sessionId, artifactId);
  return withSessionMutationFence(sessionId, async () => {
    const file = artifactPath(sessionId, artifactId);
    const current = await readRecordFile(file, artifactId);
    if (!current) throw new Error('Artifact was not found');
    if (current.artifact.headRevision !== expectedRevision) {
      throw new ArtifactRevisionConflictError(expectedRevision, current.artifact.headRevision);
    }
    const next = update(current);
    if (next.artifact.id !== artifactId || next.artifact.sessionId !== sessionId) throw new Error('Artifact identity cannot change');
    await writeRecordAtomic(file, next);
    return next;
  });
}
