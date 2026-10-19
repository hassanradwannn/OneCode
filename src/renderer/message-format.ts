/** App-owned message chrome, shared by desktop and remote after sanitization. */
export const MESSAGE_TAGS = new Set(['A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'KBD', 'LI', 'MARK', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL']);
export const MESSAGE_DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON',
  'TEXTAREA', 'SELECT', 'OPTION', 'META', 'LINK']);
export const MAX_MESSAGE_MARKUP = 256 * 1024;

export function formatMessageContent(box: HTMLElement, options: {
  languages: WeakMap<Element, string>;
  copy(text: string): Promise<boolean>;
  label?(value: string): string;
  bindLabel?(node: HTMLElement, property: 'textContent' | 'aria-label', value: string): void;
  decorateCode?(code: HTMLElement, language: string): void;
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
    if (code && language) options.decorateCode?.(code, language);
    header.append(title, copy); pre.replaceWith(panel); panel.append(header, pre);
  }
}
