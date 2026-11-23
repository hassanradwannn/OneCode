import { marked } from 'marked';

/** A document link names a path for OneCode to resolve, never a URL to navigate. */
export function workspaceLinkPath(value: string): string | null {
  if (!/^onecode-file:[^\s\\?#]{1,2048}$/.test(value)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(value.slice('onecode-file:'.length)); } catch { return null; }
  if (!/^(?:\/(?!\/)|[A-Za-z]:\/|\.\/)/.test(decoded) || /[\\\u0000-\u001f\u007f]/.test(decoded)) return null;
  const parts = decoded.replace(/^(?:[A-Za-z]:\/|\.\/|\/)/, '').split('/');
  return parts.every(part => part && part !== '.' && part !== '..') ? decoded : null;
}

export interface WorkspaceDocument {
  name: string;
  path: string;
  text: string;
  truncated: boolean;
}

export interface WorkspaceDeliverable {
  href: string;
  name: string;
  path: string;
}

export interface WorkspaceDeliverables {
  files: WorkspaceDeliverable[];
  primary: string | null;
}

export function isWorkspaceArchive(href: string): boolean {
  return /\.zip$/i.test(workspaceLinkPath(href) ?? '');
}

/** Recorded tools report an absolute virtual path. It still needs to be
 * resolved through the requesting session's current filesystem permissions. */
export function workspaceDeliverableHref(path: string): string | null {
  if (!path.startsWith('/') || !/\.(?:md|markdown|zip|sha256)$/i.test(path)) return null;
  try {
    const href = 'onecode-file:' + path.split('/').map(encodeURIComponent).join('/');
    return workspaceLinkPath(href) ? href : null;
  } catch { return null; }
}

/** The Core read tool puts its own resolved path and range on the first line.
 * File content comes on numbered lines, and metadata and errors have no range. */
export function workspaceReadDocumentPath(args: { text: string; truncated?: boolean }, result: { text: string }): string | null {
  if (args.truncated || args.text.length > 4096 || !result.text.startsWith('--- /')) return null;
  const heading = result.text.slice(0, 2300).split(/\r?\n/, 1)[0]!;
  const file = /^--- (\/.+?\.(?:md|markdown)) — (?:lines \d+-\d+(?: of \d+)?|no lines in that range(?:; the file has \d+)?), .+ ---$/i.exec(heading)?.[1];
  if (!file || !workspaceDeliverableHref(file)) return null;
  try {
    const paths = JSON.parse(args.text)?.paths;
    return Array.isArray(paths) && paths.length === 1 && typeof paths[0] === 'string' &&
      !/[*?]/.test(paths[0]) && paths[0].replace(/:\d+(?:-\d+)?$/, '') === file ? file : null;
  } catch { return null; }
}

export function workspaceLinksInMarkdown(source: string): Map<string, string> {
  const links = new Map<string, string>();
  if (source.includes('onecode-file:')) marked.walkTokens(marked.lexer(source), token => {
    if (token.type === 'link' && workspaceLinkPath(token.href)) links.set(token.href, token.text);
  });
  return links;
}

/** Infer links only for explicitly named deliverable paths, outside fenced examples. */
export function workspaceDeliverableLinks(source: string): Map<string, string> {
  const links = workspaceLinksInMarkdown(source);
  if (!/\.(?:md|markdown|zip|sha256)`/i.test(source)) return links;
  marked.walkTokens(marked.lexer(source), token => {
    if (token.type !== 'codespan' || links.size >= 24) return;
    const file = token.text.replace(/\\/g, '/');
    if (!file.includes('/') || /[:<>|\r\n]/.test(file.replace(/^[A-Za-z]:\//, '')) ||
        !/\.(?:md|markdown|zip|sha256)$/i.test(file)) return;
    const relative = /^(?:\/|[A-Za-z]:\/|\.\/)/.test(file) ? file : `./${file}`;
    const href = `onecode-file:${relative.split('/').map(encodeURIComponent).join('/')}`;
    if (workspaceLinkPath(href)) links.set(href, file.split('/').at(-1)!);
  });
  return links;
}

export const WORKSPACE_OUTPUT_INSTRUCTIONS =
  'For a copyable Markdown deliverable, save a regular .md with apply_patch. Link every delivered file by its actual approved path, for example [Handoff](onecode-file:/project/docs/handoff.md) and [Source ZIP](onecode-file:/project/docs/source.zip). Encode spaces as %20. Put the primary document link in the final reply. OneCode can open the Markdown sidebar and copy its source. Use [label](https://example.com) for web links. If writing is unavailable, use a fenced Markdown block. Reserve artifacts for interactive output or explicit requests.';
