import { marked, Parser, TextRenderer } from 'marked';

const WORKSPACE_FILE_SCHEME = 'onecode-file:';
const DELIVERABLE_EXTENSION = /\.(?:md|markdown|txt|log|csv|tsv|json|jsonl|ya?ml|xml|toml|ini|rviz|sh|bash|ps1|cmd|bat|py|zip|sha256)$/i;

/** A document link names a path for OneCode to resolve, never a URL to navigate. */
export function workspaceLinkPath(value: string): string | null {
  if (!/^onecode-file:[^\s\\?#]{1,2048}$/.test(value)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(value.slice(WORKSPACE_FILE_SCHEME.length)); } catch { return null; }
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

function encodeWorkspaceHref(path: string): string | null {
  try {
    const href = WORKSPACE_FILE_SCHEME + path.split('/').map(encodeURIComponent).join('/');
    return workspaceLinkPath(href) ? href : null;
  } catch { return null; }
}

/** Recorded tools report absolute virtual paths. Current filesystem permissions still apply. */
export function workspaceDeliverableHref(path: string): string | null {
  return path.startsWith('/') && DELIVERABLE_EXTENSION.test(path) ? encodeWorkspaceHref(path) : null;
}

/** The Core read tool puts its own resolved path and range on the first line.
 * File content comes on numbered lines, and metadata and errors have no range. */
export function workspaceReadDocumentPaths(args: { text: string; truncated?: boolean }, result: { text: string }): string[] {
  if (args.truncated || args.text.length > 4096 || !result.text.startsWith('--- ')) return [];
  let paths: unknown;
  try {
    paths = JSON.parse(args.text)?.paths;
  } catch { return []; }
  if (!Array.isArray(paths)) return [];
  const requested = new Set<string>();
  for (const value of paths) {
    if (typeof value === 'string' && !/[*?]/.test(value)) requested.add(value.replace(/:\d+(?:-\d+)?$/, ''));
  }
  const confirmed = new Set<string>();
  for (const header of result.text.matchAll(/^--- (\/[^\r\n]+?) — (?:lines \d+-\d+(?: of \d+)?|no lines in that range(?:; the file has \d+)?), [^\r\n]+ ---$/gm)) {
    const file = header[1]!;
    if (requested.has(file) && workspaceDeliverableHref(file)) confirmed.add(file);
  }
  return [...confirmed];
}

/** Translate a local Markdown destination into an internal route. Never navigate its original URI. */
function markdownWorkspaceHref(destination: string): string | null {
  if (workspaceLinkPath(destination)) return destination;
  if (/[?#\u0000-\u001f\u007f]/.test(destination)) return null;
  const fileUri = /^file:\/\//i.test(destination);
  const local = fileUri ? destination.slice('file://'.length) : destination;
  if (fileUri && (!local.startsWith('/') || local.startsWith('//') || local.includes('\\'))) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(local); } catch { return null; }
  if (fileUri && decoded.includes('\\')) return null;
  const file = (fileUri ? decoded.replace(/^\/(?=[A-Za-z]:\/)/, '') : decoded).replace(/\\/g, '/');
  if (!DELIVERABLE_EXTENSION.test(file) || /:/.test(file.replace(/^[A-Za-z]:\//, ''))) return null;
  return encodeWorkspaceHref(/^(?:\/|[A-Za-z]:\/|\.\/)/.test(file) ? file : './' + file);
}

export function workspaceLinksInMarkdown(source: string): Map<string, string> {
  const links = new Map<string, string>();
  if (source.includes('[') || source.includes('<')) marked.walkTokens(marked.lexer(source), token => {
    if (token.type !== 'link') return;
    const href = markdownWorkspaceHref(token.href);
    if (href) links.set(href, token.tokens ? new Parser().parseInline(token.tokens, new TextRenderer()) : token.text);
  });
  return links;
}

/** Infer links only for explicitly named deliverable paths, outside fenced examples. */
export function workspaceDeliverableLinks(source: string): Map<string, string> {
  const links = workspaceLinksInMarkdown(source);
  if (!source.includes('`')) return links;
  marked.walkTokens(marked.lexer(source), token => {
    if (token.type !== 'codespan' || links.size >= 24) return;
    const file = token.text.replace(/\\/g, '/');
    if (!file.includes('/') || /[:<>|\r\n]/.test(file.replace(/^[A-Za-z]:\//, '')) ||
        !DELIVERABLE_EXTENSION.test(file)) return;
    const relative = /^(?:\/|[A-Za-z]:\/|\.\/)/.test(file) ? file : `./${file}`;
    const href = encodeWorkspaceHref(relative);
    if (href && !links.has(href)) links.set(href, file.split('/').at(-1)!);
  });
  return links;
}

export const WORKSPACE_OUTPUT_INSTRUCTIONS =
  'Link each verified deliverable in the final reply using its exact approved Core path, including files made in the terminal. Use [Report](onecode-file:/project/results/report.md) or [Data](onecode-file:/project/results/data.json) and encode spaces as %20. Save copyable Markdown as a regular .md with apply_patch, or use a fenced Markdown block if writing is unavailable. Use HTTPS for web links and artifacts for interactive output.';
