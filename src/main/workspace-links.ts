import path from 'node:path';
import { workspaceLinkPath, workspaceLinksInMarkdown, type WorkspaceDocument } from '../shared/workspace-link.js';
import { effectiveCapabilities, getConfig } from './config.js';
import { getSessionProject } from './projects.js';
import { rawPromises as fs } from './rawfs.js';
import { isContained, nativePathIdentity, resolvePath } from './sandbox.js';
import { getSession, readEvents } from './session/store.js';

const MAX_DOCUMENT_BYTES = 256 * 1024;

/** Both surfaces resolve only a link recorded in the requested assistant message. */
export async function readWorkspaceDocument(sessionId: string, messageId: string, href: string): Promise<WorkspaceDocument> {
  const requested = workspaceLinkPath(href);
  const canRead = () => effectiveCapabilities(getConfig()).read;
  if (!requested || !canRead()) throw new Error('This workspace link is unavailable.');
  const session = await getSession(sessionId);
  if (!session) throw new Error('Chat not found.');
  const event = (await readEvents(sessionId, { kinds: ['assistant_message'] })).find(row =>
    row.kind === 'assistant_message' && row.messageId === messageId && row.message.text.includes(href));
  if (event?.kind !== 'assistant_message' || !workspaceLinksInMarkdown(event.message.text).has(href) || !canRead())
    throw new Error('This file link is not recorded in the chat.');
  const relative = requested.startsWith('./');
  const resolve = async () => {
    const current = await getSession(sessionId);
    if (!current || current.projectId !== session.projectId || !canRead()) throw new Error('The chat’s workspace changed.');
    const project = relative ? await getSessionProject(sessionId) : null;
    if (relative && !project) throw new Error('This file link needs a selected project.');
    const target = await resolvePath(getConfig().roots, relative ? requested.slice(2) : requested, { base: project?.virtual });
    if (project && !isContained(project.real, target.real)) throw new Error('The linked file is outside the selected project.');
    return target;
  };
  const target = await resolve();
  const initial = await fs.stat(target.real);
  if (!initial.isFile()) throw new Error('This link does not name a regular file.');
  const handle = await fs.open(target.real, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== initial.dev || before.ino !== initial.ino) throw new Error('The linked file changed.');
    const buffer = Buffer.alloc(Math.min(before.size, MAX_DOCUMENT_BYTES));
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
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer, { stream: before.size > buffer.length });
      if (text.includes('\0')) throw new Error();
    } catch { throw new Error('This file cannot be shown as a UTF-8 document.'); }
    return { name: path.basename(target.real), path: target.virtual, text, truncated: before.size > buffer.length };
  } finally { await handle.close(); }
}
