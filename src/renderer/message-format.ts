import { LanguageDescription } from '@codemirror/language';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { decorateJsonCode } from './json-code.js';

/** App-owned message chrome, shared by desktop and remote after sanitization. */
export const MESSAGE_TAGS = new Set(['A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'KBD', 'LI', 'MARK', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL']);
export const MESSAGE_DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON',
  'TEXTAREA', 'SELECT', 'OPTION', 'META', 'LINK']);
export const MAX_MESSAGE_MARKUP = 256 * 1024;

async function highlightCode(code: HTMLElement, language: string, source: string): Promise<void> {
  if (!source || source.length > 64_000) return;
  try {
    const { languages } = await import('@codemirror/language-data');
    const description = LanguageDescription.matchLanguageName(languages, language, false);
    if (!description) return;
    const { language: grammar } = await description.load();
    if (code.textContent !== source || code.querySelector('mark')) return;
    const doc = code.ownerDocument, fragment = doc.createDocumentFragment();
    let cursor = 0;
    highlightTree(grammar.parser.parse(source), classHighlighter, (from, to, classes) => {
      fragment.append(source.slice(cursor, from));
      const token = doc.createElement('span');
      token.className = classes;
      token.textContent = source.slice(from, to);
      fragment.append(token);
      cursor = to;
    });
    if (cursor === 0) return;
    fragment.append(source.slice(cursor));
    code.replaceChildren(fragment);
  } catch { /* A grammar load or parse failure leaves the original readable code. */ }
}

export function formatMessageContent(box: HTMLElement, options: {
  languages: WeakMap<Element, string>;
  copy(text: string): Promise<boolean>;
  label?(value: string): string;
  bindLabel?(node: HTMLElement, property: 'textContent' | 'aria-label', value: string): void;
  copyFailed?(): void;
}): void {
  const label = options.label ?? (value => value);
  const bind = (node: HTMLElement, property: 'textContent' | 'aria-label', value: string) => {
    if (options.bindLabel) options.bindLabel(node, property, value);
    else if (property === 'textContent') node.textContent = label(value); else node.setAttribute(property, label(value));
  };
  for (const table of box.querySelectorAll('table')) {
    const viewport = document.createElement('div'); viewport.className = 'markdown-table'; viewport.tabIndex = 0;
    viewport.setAttribute('role', 'region'); bind(viewport, 'aria-label', 'Table');
    table.replaceWith(viewport); viewport.append(table);
  }
  for (const pre of box.querySelectorAll('pre')) {
    const value = pre.textContent ?? '', code = pre.querySelector('code');
    const language = code && options.languages.get(code);
    const panel = document.createElement('div'); panel.className = 'markdown-code';
    const header = document.createElement('div'); header.className = 'tool-output-header';
    const title = document.createElement('strong'); if (language) title.textContent = language.toUpperCase(); else bind(title, 'textContent', 'Code');
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'tool-copy'; bind(copy, 'textContent', 'Copy');
    copy.addEventListener('click', () => { void (async () => {
      try { if (await options.copy(value)) bind(copy, 'textContent', 'Copied'); else options.copyFailed?.(); }
      catch { options.copyFailed?.(); }
    })(); });
    if (code && language === 'json') decorateJsonCode(code);
    else if (code && language) void highlightCode(code, language, code.textContent ?? '');
    header.append(title, copy); pre.replaceWith(panel); panel.append(header, pre);
  }
}
