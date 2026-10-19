/**
 * Fixed page helpers serialized into the Workbench browser's isolated world. Model-authored
 * JavaScript never enters this reader/target map; refs live in an isolated-world WeakMap-like
 * table and are invalidated by the main process whenever the top document navigates.
 */
export function workbenchBrowserPage(operation: string, args: Record<string, unknown>): unknown {
  const root = globalThis as typeof globalThis & { __onecodeWorkbenchBrowser?: { pageId: string; refs: Map<string, Element>; next: number } };
  const pageId = String(args.pageId ?? '');
  let state = root.__onecodeWorkbenchBrowser;
  if (!state || state.pageId !== pageId) state = root.__onecodeWorkbenchBrowser = { pageId, refs: new Map(), next: 0 };
  const fail = (message: string): never => { throw new Error(message); };
  const compact = (value: unknown, max = 300): string => String(value ?? '').slice(0, max * 4).replace(/\s+/g, ' ').trim().slice(0, max);
  const visible = (element: Element): boolean => {
    const style = getComputedStyle(element);
    return !element.closest('[inert]') && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && element.getClientRects().length > 0;
  };
  const textOf = (element: Element | null): string => {
    if (!element) return '';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let result = '', node: Node | null, count = 0;
    while (result.length < 1000 && count++ < 150 && (node = walker.nextNode())) result += node.nodeValue?.slice(0, 1000 - result.length) ?? '';
    return compact(result, 500);
  };
  const label = (element: Element): string => compact(
    element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') ||
    element.getAttribute('placeholder') || (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type) ? element.value : '') || textOf(element)
  );
  const resolve = (ref: unknown): Element => {
    const key = typeof ref === 'string' && ref.startsWith(`${pageId}:`) ? ref : fail('BROWSER_REF_STALE: use a current snapshot ref.');
    const candidate = state!.refs.get(key);
    const element = candidate?.isConnected && visible(candidate) ? candidate : fail('BROWSER_REF_STALE: snapshot again; the element is gone or hidden.');
    if (element.matches(':disabled,[aria-disabled="true"]')) fail('BROWSER_ELEMENT_DISABLED');
    return element;
  };

  if (operation === 'snapshot') {
    let scope: Element | null = document.body || document.documentElement;
    if (typeof args.selector === 'string' && args.selector) {
      try { scope = document.querySelector(args.selector); } catch { fail('BROWSER_SELECTOR_INVALID: selector must be valid CSS.'); }
      if (!scope) fail('BROWSER_SELECTOR_NOT_FOUND: the requested subtree is absent.');
    }
    state.refs.clear(); state.next = 0;
    const maxNodes = Math.max(1, Math.min(1000, Number(args.maxNodes) || 300));
    const maxChars = Math.max(100, Math.min(24000, Number(args.maxChars) || 16000));
    const filter = typeof args.filter === 'string' ? args.filter.toLocaleLowerCase() : '';
    const dom = args.format === 'dom';
    const lines: string[] = []; let chars = 0, visited = 0, elements = 0, truncated = false;
    const append = (line: string): boolean => {
      if (lines.length >= maxNodes || chars + line.length + 1 > maxChars) { truncated = true; return false; }
      lines.push(line); chars += line.length + 1; return true;
    };
    const implicit: Record<string, string> = { A: 'link', BUTTON: 'button', TEXTAREA: 'textbox', SELECT: 'combobox', CANVAS: 'canvas', IMG: 'img', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading' };
    const stack: Array<{ node: Node; depth: number }> = scope ? [{ node: scope, depth: 0 }] : [];
    while (stack.length) {
      if (++visited > 15000) { truncated = true; break; }
      const { node, depth } = stack.pop()!;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = compact(node.nodeValue, 500);
        if (text && (!filter || text.toLocaleLowerCase().includes(filter)) && !append(`${'  '.repeat(Math.min(depth, 16))}${text}`)) break;
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const element = node as Element;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'].includes(element.tagName) || !visible(element)) continue;
      let role = compact(element.getAttribute('role'), 50) || implicit[element.tagName];
      if (element instanceof HTMLInputElement) role = ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button' } as Record<string, string>)[element.type] || 'textbox';
      const editable = element instanceof HTMLElement && element.isContentEditable && !element.parentElement?.isContentEditable;
      if (!role && (editable || (element instanceof HTMLElement && element.tabIndex >= 0) || element.hasAttribute('onclick'))) role = editable ? 'textbox' : 'interactive';
      if (role || dom) {
        const name = role ? label(element) : '';
        const rect = element.getBoundingClientRect();
        const detail = dom ? `<${element.tagName.toLowerCase()}> rect=${JSON.stringify([rect.left, rect.top, rect.width, rect.height].map(value => Math.round(value * 10) / 10))}` : '';
        const match = !filter || `${role ?? ''} ${name} ${detail}`.toLocaleLowerCase().includes(filter);
        if (match) {
          const actionable = !!role && ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'slider', 'interactive', 'canvas'].includes(role);
          const ref = actionable ? `${pageId}:e${++state.next}` : null;
          if (ref) state.refs.set(ref, element);
          const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? compact(element.value, 200) : '';
          const line = `${'  '.repeat(Math.min(depth, 16))}${ref ? `[${ref}] ` : ''}${detail ? `${detail} ` : ''}${role ? `${role} ${JSON.stringify(name)}` : ''}${value ? ` value=${JSON.stringify(value)}` : ''}`;
          if (line.trim() && !append(line)) break; elements++;
          if (element instanceof HTMLSelectElement) {
            for (const option of [...element.options].slice(0, 100)) {
              if (!append(`${'  '.repeat(Math.min(depth + 1, 16))}option ${JSON.stringify(compact(option.label))} value=${JSON.stringify(option.value.slice(0, 1000))}${option.selected ? ' (selected)' : ''}`)) break;
            }
          }
        }
      }
      if (depth >= 40) { truncated = true; continue; }
      let child = element.lastChild, count = 0;
      while (child && count++ < 5000) { stack.push({ node: child, depth: depth + 1 }); child = child.previousSibling; }
      if (child) truncated = true;
    }
    return { title: compact(document.title, 500), url: location.href.slice(0, 8192), readyState: document.readyState, visibility: document.visibilityState,
      focused: document.hasFocus(), text: lines.join('\n'), truncated, visited, elements, refs: [...state.refs.keys()] };
  }

  const element = resolve(args.ref);
  if (operation === 'point') {
    const before = element.getBoundingClientRect();
    if (before.left < 0 || before.top < 0 || before.right > innerWidth || before.bottom > innerHeight) element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) fail('BROWSER_ELEMENT_OFFSCREEN');
    const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === element || element.contains(hit))) fail('BROWSER_ELEMENT_OBSTRUCTED: target is covered. Snapshot again.');
    return { x, y };
  }
  if (operation === 'focus') {
    const html = element instanceof HTMLElement ? element : fail('BROWSER_NOT_EDITABLE');
    if (html instanceof HTMLInputElement && html.type === 'file') fail('BROWSER_FILE_INPUT: use an explicit file upload workflow.');
    if ('readOnly' in html && (html as HTMLInputElement | HTMLTextAreaElement).readOnly) fail('BROWSER_ELEMENT_READONLY');
    html.focus({ preventScroll: true });
    if (document.activeElement !== html) fail('BROWSER_FOCUS_FAILED');
    if (args.replace === true) {
      if ((html instanceof HTMLInputElement || html instanceof HTMLTextAreaElement) && typeof html.select === 'function') html.select();
      else if (html.isContentEditable) { const range = document.createRange(); range.selectNodeContents(html); const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
    }
    return true;
  }
  if (operation === 'select') {
    const select = element instanceof HTMLSelectElement && Array.isArray(args.values) ? element : fail('BROWSER_NOT_SELECT');
    const values = (args.values as unknown[]).map(String);
    if (!select.multiple && values.length !== 1) fail('BROWSER_SELECT_VALUES');
    const options = [...select.options];
    if (values.some(value => !options.some(option => option.value === value && !option.disabled))) fail('BROWSER_OPTION_UNAVAILABLE');
    for (const option of options) option.selected = values.includes(option.value);
    select.dispatchEvent(new Event('input', { bubbles: true })); select.dispatchEvent(new Event('change', { bubbles: true }));
    return { values: options.filter(option => option.selected).map(option => option.value) };
  }
  fail('BROWSER_OPERATION_UNKNOWN');
}

/** Bounded serialization runs in the page before CDP attempts to clone arbitrary site state. */
export function workbenchBrowserBoundedValue(value: unknown): unknown {
  let budget = 20000, truncated = false; const seen = new WeakSet<object>();
  const read = (input: unknown, depth: number): unknown => {
    if (budget <= 0) { truncated = true; return '[truncated]'; }
    if (input === null || typeof input === 'boolean' || typeof input === 'number') { budget -= 20; return input; }
    if (typeof input === 'string') { const result = input.slice(0, Math.max(0, Math.min(budget, 12000))); budget -= result.length; if (result.length < input.length) truncated = true; return result; }
    if (typeof input !== 'object') return String(input).slice(0, 100);
    if (seen.has(input)) return '[circular]'; if (depth >= 5) { truncated = true; return '[depth limit]'; } seen.add(input);
    const result: unknown[] | Record<string, unknown> = Array.isArray(input) ? [] : Object.create(null) as Record<string, unknown>;
    let count = 0; for (const key of Object.keys(input as object)) { if (++count > 100 || budget <= 0) { truncated = true; break; }
      const value = read((input as Record<string, unknown>)[key], depth + 1); if (Array.isArray(result)) result.push(value); else result[key.slice(0, 100)] = value; }
    return result;
  };
  return { value: read(value, 0), truncated };
}
