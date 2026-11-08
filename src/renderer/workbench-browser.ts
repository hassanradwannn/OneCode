import type { WorkbenchBrowserState } from '../shared/workbench-browser.js';
import { el, icon, toast } from './dom.js';
import { t, ui } from './i18n.js';

export function createWorkbenchBrowserPanel(options: { onEscape?: () => void; onOpen?: () => void }) {
  const pane = el('section', 'workbench-browser-panel'); pane.hidden = true;
  const toolbar = el('div', 'workbench-browser-toolbar');
  const back = el('button', 'btn btn-icon') as HTMLButtonElement; back.type = 'button'; back.append(icon('i-back')); ui(back, 'title', () => t('Back'));
  const forward = el('button', 'btn btn-icon') as HTMLButtonElement; forward.type = 'button'; forward.append(icon('i-arrow-right')); ui(forward, 'title', () => t('Forward'));
  const reload = el('button', 'btn btn-icon') as HTMLButtonElement; reload.type = 'button'; reload.append(icon('i-retry')); ui(reload, 'title', () => t('Reload'));
  const address = document.createElement('input'); address.className = 'workbench-browser-address'; address.type = 'text'; address.spellcheck = false;
  address.autocomplete = 'off'; address.setAttribute('aria-label', t('Address'));
  const agent = el('span', 'workbench-browser-agent'); agent.hidden = true; agent.append(icon('i-bolt'), el('span', '', () => t('Agent control')));
  const tabStrip = el('div', 'workbench-browser-tabs');
  tabStrip.setAttribute('role', 'tablist'); ui(tabStrip, 'aria-label', () => t('Browser tabs'));
  const add = el('button', 'btn btn-icon') as HTMLButtonElement; add.type = 'button'; add.append(icon('i-plus')); ui(add, 'title', () => t('New tab'));
  const close = el('button', 'btn btn-icon') as HTMLButtonElement; close.type = 'button'; close.append(icon('i-x')); ui(close, 'title', () => t('Close tab'));
  toolbar.append(back, forward, reload, address, agent, add, close);
  const viewport = el('div', 'workbench-browser-viewport');
  viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', t('Browser page'));
  const empty = el('div', 'workbench-browser-empty', () => t('Open a tab to browse a page here.')); viewport.append(empty);
  const conflict = el('div', 'workbench-browser-empty', () => t('Another chat owns this preview port. Open a different URL.'));
  conflict.hidden = true; conflict.setAttribute('role', 'status'); viewport.append(conflict);
  pane.append(tabStrip, toolbar, viewport);

  let sessionId: string | null = null, state: WorkbenchBrowserState | null = null, shown = false, generation = 0, request = 0, frame = 0;
  const tabButtons = new Map<number, HTMLButtonElement>();
  const current = () => state?.tabs.find(tab => tab.id === state?.activeId) ?? null;

  function hideNative(id: string): void { void window.api.workbenchBrowserHide(id).catch(() => undefined); }
  function overlayOpen(rect: DOMRect): boolean {
    if (document.querySelector('dialog[open]')) return true;
    const overlays = document.querySelectorAll('details[open] > :is(.work-dock-menu, .answer-export-menu), .composer-menu[open] > :not(summary), .file-branch-menu, [role="menu"]');
    return [...overlays].some(menu => {
      const bounds = menu.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && bounds.left < rect.right && bounds.right > rect.left &&
        bounds.top < rect.bottom && bounds.bottom > rect.top;
    });
  }
  function schedulePresentation(): void {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { frame = 0; present(); });
  }
  function present(): void {
    const id = sessionId, tab = current();
    if (!id) return;
    if (!tab || tab.previewConflict || !shown || pane.hidden || !viewport.isConnected || document.visibilityState === 'hidden') {
      hideNative(id); return;
    }
    // The native child does not follow renderer layout animations.
    if (pane.closest('.work-dock-right')?.classList.contains('is-moving')) {
      hideNative(id); schedulePresentation(); return;
    }
    const rect = viewport.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || overlayOpen(rect)) { hideNative(id); return; }
    void window.api.workbenchBrowserPresent(id, tab.id, {
      x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height
    }, true).catch(() => undefined);
  }

  function paint(next: WorkbenchBrowserState | null): void {
    const previous = current();
    state = next;
    const active = current(), tabs = next?.tabs ?? [];
    for (const [id, button] of tabButtons) {
      if (!tabs.some(tab => tab.id === id)) { button.remove(); tabButtons.delete(id); }
    }
    for (const tab of tabs) {
      let button = tabButtons.get(tab.id);
      if (!button) {
        button = el('button', 'btn') as HTMLButtonElement;
        button.type = 'button'; button.setAttribute('role', 'tab');
        button.addEventListener('click', () => void select(tab.id));
        tabButtons.set(tab.id, button); tabStrip.append(button);
      }
      button.textContent = button.title = tab.title || tab.url || t('New tab');
      button.setAttribute('aria-selected', String(tab.id === active?.id));
      button.tabIndex = tab.id === active?.id ? 0 : -1;
    }
    tabStrip.hidden = !tabs.length; close.disabled = !active;
    back.disabled = !active?.canGoBack; forward.disabled = !active?.canGoForward; reload.disabled = !active;
    ui(reload, 'title', () => t(active?.loading ? 'Stop loading' : 'Reload'));
    agent.hidden = !active?.modelControlled; agent.title = active?.modelControlled ? t('The coding agent can interact with this exact tab.') : '';
    empty.hidden = !!active; conflict.hidden = !active?.previewConflict;
    address.disabled = !active;
    if (previous?.id !== active?.id || document.activeElement !== address) address.value = active?.url ?? '';
    if (!active || active.previewConflict) { if (sessionId) hideNative(sessionId); }
    else schedulePresentation();
  }

  type BrowserReply = ReturnType<typeof window.api.workbenchBrowserState>;
  async function apply(operation: (id: string) => BrowserReply): Promise<boolean> {
    const id = sessionId, owner = generation, token = ++request;
    if (!id) return false;
    const reply = await operation(id).catch((error: unknown) => ({ ok: false as const, error: String(error) }));
    if (owner !== generation || id !== sessionId) return false;
    if (!reply.ok) { toast(t(reply.error)); return false; }
    if (reply.data.sessionId !== id) return false;
    if (token === request) paint(reply.data);
    return true;
  }
  const refresh = (ensure = false) => apply(id => ensure ? window.api.workbenchBrowserEnsure(id) : window.api.workbenchBrowserState(id));
  const select = (tabId: number) => apply(id => window.api.workbenchBrowserSelect(id, tabId));
  const newTab = () => apply(id => window.api.workbenchBrowserNew(id));

  async function show(): Promise<void> {
    if (!sessionId) return;
    shown = true; pane.hidden = false;
    await refresh(true);
  }
  function hide(): void { shown = false; pane.hidden = true; if (sessionId) hideNative(sessionId); }
  function mountAt(parent: HTMLElement): void { if (pane.parentElement !== parent) parent.append(pane); schedulePresentation(); }
  function sync(next: string | null): void {
    if (next === sessionId) return;
    if (sessionId) hideNative(sessionId);
    sessionId = next; generation++; paint(null);
    if (!next) { hide(); return; }
    if (shown) void refresh(true);
  }

  const history = (action: 'back' | 'forward' | 'reload' | 'stop') => {
    const tab = current(); if (tab) void apply(id => window.api.workbenchBrowserHistory(id, tab.id, action));
  };
  back.addEventListener('click', () => history('back')); forward.addEventListener('click', () => history('forward'));
  reload.addEventListener('click', () => history(current()?.loading ? 'stop' : 'reload'));
  address.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const tab = current(), url = address.value.trim();
    if (tab && url) void apply(id => window.api.workbenchBrowserNavigate(id, tab.id, url));
  });
  tabStrip.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const ids = [...tabButtons.keys()];
    if (!ids.length) return;
    event.preventDefault();
    const index = ids.indexOf(current()?.id ?? ids[0]!);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length;
    tabButtons.get(ids[next]!)?.focus();
    void select(ids[next]!);
  });
  add.addEventListener('click', () => void newTab());
  close.addEventListener('click', () => {
    const tab = current();
    if (tab) void apply(id => window.api.workbenchBrowserClose(id, tab.id));
  });
  pane.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); options.onEscape?.(); } });

  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedulePresentation) : null; resize?.observe(viewport);
  window.addEventListener('resize', schedulePresentation); document.addEventListener('visibilitychange', schedulePresentation);
  const overlayObserver = new MutationObserver(records => {
    if (records.some(record => !pane.contains(record.target) && (record.type === 'attributes' ||
      [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node as Element).matches('dialog, .file-branch-menu, [role="menu"]')))))
      schedulePresentation();
  });
  overlayObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'hidden'] });
  document.addEventListener('toggle', schedulePresentation, true);
  window.api.onWorkbenchBrowserChanged?.(change => {
    if (change.sessionId !== sessionId) return;
    if (change.reveal) options.onOpen?.();
    else if (shown) void refresh();
  });

  paint(null);
  return { pane, mountAt, show, hide, sync, newTab, visible: () => shown && !pane.hidden };
}
