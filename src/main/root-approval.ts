/** Folder grants are created only by trusted user actions, never by model/tool text. */
import path from 'node:path';
import { updateConfig } from './config.js';
import { rootContains, uniqueRootName, validateNewRoot } from './sandbox.js';
import { rawPromises as fs } from './rawfs.js';
import { wakeBrowserWork } from './browser-wake.js';
import { DEFAULT_CAPABILITIES, type Capabilities } from '../shared/types.js';

/** Direct human declarations only. The trusted submission boundary owns calling this parser. */
export function messageCapabilityApprovals(text: string): { full: boolean; capabilities: Array<keyof Capabilities>; workers: boolean; commandPrograms?: string[] } {
  const result = { full: false, capabilities: [] as Array<keyof Capabilities>, workers: false };
  if (text.length > 240000 || text.includes('\0')) return result;
  const aliases: Array<[RegExp, Array<keyof Capabilities>]> = [
    [/^(?:run (?:shell |terminal |gh |git |github )?commands?|command execution|terminal(?: access)?|shell(?: access)?|(?:use )?gh(?: commands?| access)?|github cli)$/i, ['command']],
    [/^(?:read(?: files)?|file read(?: access)?)$/i, ['read']],
    [/^(?:create(?: files)?|file creat(?:e|ion))$/i, ['create']],
    [/^(?:edit(?: files)?|file edit(?:ing)?)$/i, ['edit']],
    [/^(?:write(?: files)?|file writ(?:e|ing)(?: access)?)$/i, ['create', 'edit']],
    [/^(?:move(?: files)?|rename(?: files)?)$/i, ['move']],
    [/^(?:delete(?: files)?|file delet(?:e|ion))$/i, ['deleteFile']],
    [/^(?:screen(?: access| capture|shots)?|view (?:the )?screen)$/i, ['screen']],
    [/^(?:control(?: (?:the )?(?:computer|desktop))?|computer control|desktop control)$/i, ['control']],
    [/^(?:read (?:the )?clipboard|clipboard read)$/i, ['clipboardRead']],
    [/^(?:write (?:the )?clipboard|clipboard write)$/i, ['clipboardWrite']],
    [/^(?:browse(?: files| folders)?|list (?:files|folders))$/i, ['browse']],
    [/^(?:search(?: files)?|file search)$/i, ['search']],
    [/^(?:metadata|file metadata)$/i, ['metadata']]
  ];
  let fence: string | null = null, documentDepth = 0;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null; continue; }
    if (fence || /^\s*>|^(?: {4}|\t)/.test(line)) continue;
    if (/^\s*<\//.test(line)) { documentDepth = Math.max(0, documentDepth - 1); continue; }
    if (/^\s*<[A-Za-z_]/.test(line)) { documentDepth++; continue; }
    if (documentDepth) continue;
    // Entire standalone declarations: negation, conditions and reported speech never match.
    const grant = /^\s*(?:i\s+(?:give|grant)\s+you\s+(?:my\s+)?(?:explicit\s+)?(?:permission\s+to\s+|access\s+to\s+)?|i\s+(?:allow|authorize|permit)\s+you\s+to\s+|you\s+(?:have\s+(?:my\s+)?(?:explicit\s+)?(?:permission\s+to\s+)?|can\s+|are allowed to\s+)|(?:please\s+)?enable\s+)([^.!?\r\n]+)[.!]?\s*$/i.exec(line);
    if (!grant) continue;
    const value = grant[1]!.trim().replace(/\s+/g, ' ');
    if (/^(?:full access(?: to (?:all )?(?:tools|commands))?|all permissions|all capabilities|use (?:all|any) tools|unrestricted command execution)$/i.test(value)) {
      if (value.toLowerCase() === 'unrestricted command execution') result.capabilities.push('command');
      else result.full = true;
      continue;
    }
    const parts = value.split(/\s*(?:,|\band\b)\s*/i);
    const caps: Array<keyof Capabilities> = [];
    let workers = false, valid = true;
    for (const part of parts) {
      if (/^(?:workers|multi-agent(?: mode)?|spawn workers|use workers)$/i.test(part)) { workers = true; continue; }
      const match = aliases.find(([pattern]) => pattern.test(part));
      if (!match) { valid = false; break; }
      caps.push(...match[1]);
    }
    if (valid) {
      result.capabilities.push(...caps); result.workers ||= workers;
      if (caps.includes('command')) {
        const programs = parts.flatMap(part => /\b(?:gh|github)\b/i.test(part) ? ['gh'] : /\bgit\b/i.test(part) ? ['git'] : []);
        if (programs.length) Object.assign(result, { commandPrograms: [...new Set(programs)] });
      }
    }
  }
  result.capabilities = [...new Set(result.capabilities)];
  return result;
}

export async function approveFolder(folderPath: string): Promise<void> {
  await approvePath(folderPath, false);
}

/** Same durable root owner for a picker folder and a path in trusted user text. */
export async function approvePath(nativePath: string, allowFile = true): Promise<void> {
  await updateConfig(async config => {
    // Validate native/network spelling before any realpath can contact a host.
    const real = await validateNewRoot(nativePath, [], { allowFile });
    const file = (await fs.stat(real)).isFile();
    if (config.roots.some(root => rootContains(root, real) && (root.kind !== 'file' || file))) return config;
    const approved = await validateNewRoot(real, config.roots, { allowFile, allowContainingRoots: allowFile });
    return { ...config, roots: [...config.roots, { name: uniqueRootName(approved, config.roots), path: approved,
      ...(file ? { kind: 'file' as const } : {}) }] };
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

function nativeMessagePath(value: string, platform: NodeJS.Platform): string | null {
  let candidate = value.trim();
  if (/^[`"']/.test(candidate)) {
    if (candidate.at(-1) !== candidate[0] || candidate.slice(1, -1).includes(candidate[0]!)) return null;
    candidate = candidate.slice(1, -1);
  }
  if (!candidate || candidate.length > 4096 || /[\u0000-\u001f\u007f`<>]/.test(candidate)) return null;
  const native = platform === 'win32' ? path.win32 : path.posix;
  if (!native.isAbsolute(candidate) || native.parse(native.normalize(candidate)).root === native.normalize(candidate) ||
      candidate.split(/[\\/]+/).some(part => part === '.' || part === '..')) return null;
  if (platform === 'win32' && (!/^(?:[A-Za-z]:[\\/]|\\\\(?:wsl\.localhost|wsl\$)\\)/i.test(candidate) ||
      /["|?*]/.test(candidate) || candidate.slice(2).includes(':'))) return null;
  return candidate;
}

/** Direct user paths only: standalone lines or quoted paths in a task directive.
 * Never call on prompt envelopes, model text, attached documents or automation. */
export function messagePathApprovals(text: string, platform: NodeJS.Platform = process.platform): string[] {
  if (text.length > 240000 || text.includes('\0')) return [];
  const paths = new Set<string>();
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null; continue; }
    if (fence || /^\s*>|^(?: {4}|\t)/.test(line)) continue;
    const direct = nativeMessagePath(writtenFolderApproval(line, platform) ?? line, platform);
    if (direct) paths.add(direct);
    else if (/^\s*(?:(?:please|can you|could you)\s+){0,2}(?:read|scan|open|use|inspect|review|analy[sz]e|edit|create|save|write|list|check|search|summari[sz]e|process|access)\b/i.test(line) &&
        !/\b(?:do not|don't|never|unless)\b/i.test(line)) {
      const remainder = line.replace(/^\s*(?:(?:please|can you|could you)\s+){0,2}(?:read|scan|open|use|inspect|review|analy[sz]e|edit|create|save|write|list|check|search|summari[sz]e|process|access)\s+/i, '');
      const terminalPath = nativeMessagePath(remainder, platform);
      if (terminalPath) paths.add(terminalPath);
      for (const match of line.matchAll(/`([^`\r\n]{1,4096})`|"([^"\r\n]{1,4096})"|'([^'\r\n]{1,4096})'/g)) {
        const candidate = nativeMessagePath(match[1] ?? match[2] ?? match[3]!, platform);
        if (candidate) paths.add(candidate);
      }
    }
    if (paths.size >= 16) break;
  }
  return [...paths];
}

export async function applyWrittenFolderApproval(text: string): Promise<boolean> {
  let applied = false;
  const grant = messageCapabilityApprovals(text);
  if (grant.full || grant.capabilities.length || grant.workers) {
    await updateConfig(config => {
      const capabilities = { ...config.capabilities };
      for (const key of grant.full ? Object.keys(DEFAULT_CAPABILITIES) as Array<keyof Capabilities> : grant.capabilities)
        capabilities[key] = true;
      let commandAllowlist = config.commandAllowlist;
      if (grant.full || grant.capabilities.includes('command') && !grant.commandPrograms) commandAllowlist = { ...commandAllowlist, enabled: false };
      else if (grant.commandPrograms) {
        if (!config.capabilities.command && !commandAllowlist.enabled)
          commandAllowlist = { enabled: true, mode: 'allow', rules: grant.commandPrograms.map(program => `${program} *`) };
        else if (commandAllowlist.enabled) commandAllowlist = { ...commandAllowlist,
          rules: commandAllowlist.mode === 'allow'
            ? [...new Set([...commandAllowlist.rules, ...grant.commandPrograms.map(program => `${program} *`)])]
            : commandAllowlist.rules.filter(rule => !grant.commandPrograms!.some(program => rule === program || rule.startsWith(`${program} `))) };
      }
      return { ...config, capabilities, commandAllowlist,
        ...(grant.full || grant.capabilities.some(key => ['create', 'edit', 'move', 'deleteFile', 'command', 'control', 'clipboardWrite'].includes(key)) ? { readOnly: false } : {}),
        ...(grant.workers ? { multiAgent: { ...config.multiAgent, enabled: true } } : {}) };
    });
    wakeBrowserWork();
    applied = true;
  }
  for (const candidate of messagePathApprovals(text)) {
    try { await approvePath(candidate); applied = true; }
    catch (error) {
      // A mention of a missing path cannot approve its guessed parent. Existing
      // explicit paths still retain the ordinary root owner's validation errors.
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return applied;
}
