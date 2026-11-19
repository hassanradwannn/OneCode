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

export function workspaceLinksInMarkdown(source: string): Map<string, string> {
  const links = new Map<string, string>();
  if (source.includes('onecode-file:')) marked.walkTokens(marked.lexer(source), token => {
    if (token.type === 'link' && workspaceLinkPath(token.href)) links.set(token.href, token.text);
  });
  return links;
}

export const WORKSPACE_OUTPUT_INSTRUCTIONS =
  'For a copyable Markdown file, save a regular .md with apply_patch. Link its actual approved path as [Guide](onecode-file:/project/docs/guide.md), with spaces encoded as %20, for sidebar preview and source copy. Use [label](https://example.com) for web links. If writing is unavailable, use a fenced Markdown block. Reserve artifacts for interactive output or explicit requests. Finish with the outcome, checks, and key file links.';
