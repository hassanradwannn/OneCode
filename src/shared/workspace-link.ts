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
