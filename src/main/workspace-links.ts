import path from 'node:path';
import { isWorkspaceArchive, workspaceDeliverableHref, workspaceDeliverableLinks, workspaceLinkPath, workspaceLinksInMarkdown, workspaceReadDocumentPath,
  type WorkspaceDeliverables, type WorkspaceDocument } from '../shared/workspace-link.js';
import { positionOf } from '../shared/chronology.js';
import { answerAnchors, completedTurnIds } from '../shared/markdown-export.js';
import { effectiveCapabilities, getConfig } from './config.js';
import { getSessionProject } from './projects.js';
import { rawPromises as fs } from './rawfs.js';
import { isContained, nativePathIdentity, resolvePath } from './sandbox.js';
import { getSession, readEvents } from './session/store.js';
import { readTurnChanges } from './session/turn-changes.js';

const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const canRead = () => effectiveCapabilities(getConfig()).read;

async function recordedWorkspaceLinks(sessionId: string, messageId: string) {
  if (!canRead()) throw new Error('This workspace link is unavailable.');
  const session = await getSession(sessionId);
  if (!session) throw new Error('Chat not found.');
  const messages = await readEvents(sessionId, { kinds: ['assistant_message'] });
  const event = messages.findLast(row => row.kind === 'assistant_message' && row.messageId === messageId);
  if (event?.kind !== 'assistant_message' || !canRead()) throw new Error('This file link is not recorded in the chat.');
  const completeText = event.final && !event.message.truncated;
  const links = completeText ? workspaceDeliverableLinks(event.message.text) : workspaceLinksInMarkdown(event.message.text);
  if (links.size || !completeText || !event.turnId) return { session, event, links, mayAutoOpen: true };

  const evidence = await readEvents(sessionId, { kinds: ['tool_call', 'turn_end'] });
  if (answerAnchors([...messages, ...evidence]).get(event.turnId) !== event.seq) return { session, event, links, mayAutoOpen: false };
  const calls = evidence.filter(row => row.kind === 'tool_call')
    .filter(row => row.call.outcome === 'ok' && positionOf(row) < positionOf(event));
  const sameTurn = calls.filter(row => row.turnId === event.turnId);
  const changed = new Set(sameTurn.flatMap(row => row.call.changes?.map(change => change.path) ?? []));
  function offer(file: string) {
    const href = workspaceDeliverableHref(file);
    if (href) links.set(href, path.posix.basename(file));
  }
  for (const file of changed) offer(file);
  if (links.size) return { session, event, links, mayAutoOpen: changed.size === 1 };

  // A link-only reply may omit the path again. A successful single-file read
  // can re-offer an existing deliverable from this chat's own earlier turn.
  const reads = new Set(sameTurn.flatMap(({ call }) => {
    const file = call.tool === 'read' ? workspaceReadDocumentPath(call.args, call.result) : null;
    return file ? [file] : [];
  }));
  if (reads.size === 1) {
    const [file] = reads;
    const completed = completedTurnIds(evidence.filter(row => positionOf(row) < positionOf(event)));
    if (file && calls.some(row => row.turnId && row.turnId !== event.turnId && completed.has(row.turnId) &&
        row.call.changes?.some(change => change.path === file))) offer(file);
  }
  return { session, event, links, mayAutoOpen: false };
}

async function resolveWorkspaceLink(sessionId: string, projectId: string | undefined | null, requested: string) {
  const relative = requested.startsWith('./');
  const current = await getSession(sessionId);
  if (!current || current.projectId !== projectId || !canRead()) throw new Error('The chat’s workspace changed.');
  const project = relative ? await getSessionProject(sessionId) : null;
  if (relative && !project) throw new Error('This file link needs a selected project.');
  const target = await resolvePath(getConfig().roots, relative ? requested.slice(2) : requested, { base: project?.virtual });
  if (project && !isContained(project.real, target.real)) throw new Error('The linked file is outside the selected project.');
  return target;
}

export async function listWorkspaceDeliverables(sessionId: string, messageId: string): Promise<WorkspaceDeliverables> {
  const { session, event, links, mayAutoOpen } = await recordedWorkspaceLinks(sessionId, messageId);
  const entries = await Promise.all([...links.keys()].slice(0, 24).map(async href => {
    try {
      const target = await resolveWorkspaceLink(sessionId, session.projectId, workspaceLinkPath(href)!);
      if (!(await fs.stat(target.real)).isFile()) return null;
      return { href, name: path.basename(target.real), path: target.virtual };
    } catch { return null; }
  }));
  const files = [...new Map(entries.flatMap(entry => entry ? [[entry.path, entry] as const] : [])).values()];
  const markdown = files.filter(file => /\.(?:md|markdown)$/i.test(file.name));
  const changes = mayAutoOpen && event.final && event.turnId && markdown.length === 1 ? await readTurnChanges(sessionId, event.turnId).catch(() => []) : [];
  const primary = markdown.length === 1 && changes.some(change => change.path === markdown[0]!.path) ? markdown[0]!.href : null;
  if (!canRead() || (await getSession(sessionId))?.projectId !== session.projectId) throw new Error('The chat’s workspace changed.');
  return { files, primary };
}

/** Both surfaces resolve only a path recorded in the requested assistant message. */
async function readWorkspaceFile(sessionId: string, messageId: string, href: string, maxBytes: number, requireComplete: boolean) {
  const requested = workspaceLinkPath(href);
  if (!requested) throw new Error('This workspace link is unavailable.');
  const { session, links } = await recordedWorkspaceLinks(sessionId, messageId);
  if (!links.has(href)) throw new Error('This file link is not recorded in the chat.');
  const resolve = () => resolveWorkspaceLink(sessionId, session.projectId, requested);
  const target = await resolve();
  const initial = await fs.stat(target.real);
  if (!initial.isFile()) throw new Error('This link does not name a regular file.');
  const handle = await fs.open(target.real, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== initial.dev || before.ino !== initial.ino) throw new Error('The linked file changed.');
    if (requireComplete && before.size > maxBytes) throw new Error('This archive exceeds the download size limit.');
    const buffer = Buffer.alloc(Math.min(before.size, maxBytes));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const current = await resolve();
    const after = await handle.stat();
    const addressed = await fs.stat(current.real);
    if (!canRead() || nativePathIdentity(current.real) !== nativePathIdentity(target.real) ||
        addressed.dev !== after.dev || addressed.ino !== after.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || offset !== buffer.length) throw new Error('The linked file changed.');
    return { name: path.basename(target.real), path: target.virtual, buffer, truncated: before.size > buffer.length };
  } finally { await handle.close(); }
}

export async function readWorkspaceDocument(sessionId: string, messageId: string, href: string): Promise<WorkspaceDocument> {
  const { buffer, ...file } = await readWorkspaceFile(sessionId, messageId, href, MAX_DOCUMENT_BYTES, false);
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer, { stream: file.truncated });
    if (text.includes('\0')) throw new Error();
    return { ...file, text };
  } catch { throw new Error('This file cannot be shown as a UTF-8 document.'); }
}

export async function readWorkspaceArchive(sessionId: string, messageId: string, href: string) {
  if (!isWorkspaceArchive(href)) throw new Error('This link does not name a ZIP archive.');
  return readWorkspaceFile(sessionId, messageId, href, MAX_ARCHIVE_BYTES, true);
}
