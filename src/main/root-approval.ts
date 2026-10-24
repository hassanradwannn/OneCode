/** Folder grants are created only by trusted user actions, never by model/tool text. */
import path from 'node:path';
import { updateConfig } from './config.js';
import { isContained, uniqueRootName, validateNewRoot } from './sandbox.js';
import { rawRealpathNative } from './rawfs.js';
import { wakeBrowserWork } from './browser-wake.js';

export async function approveFolder(folderPath: string): Promise<void> {
  await updateConfig(async config => {
    const real = await rawRealpathNative(folderPath);
    if (config.roots.some(root => isContained(root.path, real))) return config;
    const approved = await validateNewRoot(real, config.roots);
    return { ...config, roots: [...config.roots, { name: uniqueRootName(approved, config.roots), path: approved }] };
  });
  wakeBrowserWork();
}

/** Intentionally a standalone declaration, not a search through quoted documents or prompts. */
export function writtenFolderApproval(text: string, platform: NodeJS.Platform = process.platform): string | null {
  if (text.length > 4600 || /[\r\n\0]/.test(text)) return null;
  const match = /^\s*(?:i\s+(?:give|grant)\s+you\s+(?:my\s+)?(?:explicit\s+)?(?:access|permission|approval)\s+(?:to\s+(?:access\s+)?)|i\s+(?:approve|authorize)\s+(?:access\s+to\s+|you\s+to\s+access\s+))(.+?)\s*[.!]?\s*$/i.exec(text);
  if (!match) return null;
  let folder = match[1]!.trim();
  if (/^[`"']/.test(folder)) {
    if (folder.at(-1) !== folder[0]) return null;
    folder = folder.slice(1, -1);
  }
  if (/[`"'<>\r\n]/.test(folder) || !folder || /\s+(?:and|but|if|unless|provided)\s+/i.test(folder)) return null;
  const native = platform === 'win32' ? path.win32 : path.posix;
  if (!native.isAbsolute(folder) || native.parse(folder).root === folder ||
      (platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(folder))) return null;
  return folder;
}

export async function applyWrittenFolderApproval(text: string): Promise<boolean> {
  const folder = writtenFolderApproval(text);
  if (!folder) return false;
  await approveFolder(folder);
  return true;
}
