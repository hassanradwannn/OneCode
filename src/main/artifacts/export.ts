import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import path from 'node:path';
import type { ArtifactExportResult } from '../../shared/artifact.js';
import { rawPromises as fs } from '../rawfs.js';
import { projectWorkspace } from '../projects.js';
import { nativePathIdentity } from '../sandbox.js';
import { readArtifact } from './service.js';

function directoryName(title: string, artifactId: string, revision: number): string {
  const stem = title.normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'artifact';
  return `${stem}-${artifactId.slice(0, 8)}-r${revision}`;
}

/**
 * Publishes one retained artifact revision into its explicitly bound LocalProject.
 *
 * The destination root is created exclusively before any file is written. Every file is staged
 * beside its final name, flushed, then renamed. A collision therefore refuses the whole export
 * rather than replacing user work. Cleanup removes only entries created by this call; if another
 * process adds something to the new folder concurrently, that foreign entry is left untouched.
 */
export async function exportArtifactToProject(
  sessionId: string, artifactId: string, revision?: number
): Promise<ArtifactExportResult> {
  const snapshot = await readArtifact(sessionId, artifactId, revision);
  if (!snapshot) throw new Error('Artifact revision was not found');
  const projectId = snapshot.artifact.projectId;
  if (!projectId) throw new Error('This artifact is not linked to a local project');
  const workspace = await projectWorkspace(projectId);
  const rootIdentity = nativePathIdentity(workspace.real);
  const directory = directoryName(snapshot.artifact.title, artifactId, snapshot.revision.revision);
  const destination = path.join(workspace.real, directory);
  const createdFiles: string[] = [];
  const createdDirectories: string[] = [];
  const temporaryFiles: string[] = [];
  let rootCreated = false;
  try {
    try { await fs.mkdir(destination); rootCreated = true; createdDirectories.push(destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Project export already exists: ${directory}`);
      throw error;
    }
    for (const file of snapshot.revision.files) {
      const pieces = file.path.split('/');
      let parent = destination;
      for (const piece of pieces.slice(0, -1)) {
        parent = path.join(parent, piece);
        if (!createdDirectories.includes(parent)) {
          await fs.mkdir(parent);
          createdDirectories.push(parent);
        }
      }
      const finalPath = path.join(parent, pieces.at(-1)!);
      const temporary = path.join(parent, `.onecode-${randomUUID()}.tmp`);
      if (nativePathIdentity(await fs.realpath(parent)) !== nativePathIdentity(parent)) throw new Error('Artifact export directory changed');
      temporaryFiles.push(temporary);
      const handle = await fs.open(temporary, 'wx');
      try { await handle.writeFile(file.text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      const currentWorkspace = await projectWorkspace(projectId);
      if (nativePathIdentity(currentWorkspace.real) !== rootIdentity) throw new Error('Project folder changed while exporting the artifact');
      if (nativePathIdentity(await fs.realpath(parent)) !== nativePathIdentity(parent)) throw new Error('Artifact export directory changed');
      try { await fs.link(temporary, finalPath); }
      catch (error) {
        if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV', 'EMLINK'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await fs.copyFile(temporary, finalPath, constants.COPYFILE_EXCL);
      }
      createdFiles.push(finalPath);
      await fs.unlink(temporary);
      temporaryFiles.splice(temporaryFiles.indexOf(temporary), 1);
    }
    return { artifactId, revision: snapshot.revision.revision, projectId, directory,
      files: snapshot.revision.files.map(file => `${directory}/${file.path}`) };
  } catch (error) {
    for (const temporary of temporaryFiles) await fs.rm(temporary, { force: true }).catch(() => undefined);
    for (const file of [...createdFiles].reverse()) await fs.unlink(file).catch(() => undefined);
    for (const directoryPath of [...createdDirectories].reverse()) await fs.rmdir(directoryPath).catch(() => undefined);
    throw error;
  } finally {
    if (!rootCreated) {
      // No cleanup outside the directory this call created exclusively.
    }
  }
}
