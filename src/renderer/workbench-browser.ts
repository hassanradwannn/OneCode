import type { WorkbenchBrowserState } from '../shared/workbench-browser.js';
import { el, icon, run } from './dom.js';
import { t, ui } from './i18n.js';

export function createWorkbenchBrowserPanel(options: { onEscape?: () => void }) {
  const pane = el('section', 'workbench-browser-panel'); pane.hidden = true;
  const toolbar = el('div', 'workbench-browser-toolbar');
  const back = el('button', 'btn btn-icon') as HTMLButtonElement; back.type = 'button'; back.append(icon('i-back')); ui(back, 'title', () => t('Back'));
  const forward = el('button', 'btn btn-icon') as HTMLButtonElement; forward.type = 'button'; forward.append(icon('i-arrow-right')); ui(forward, 'title', () => t('Forward'));
  const reload = el('button', 'btn btn-icon') as HTMLButtonElement; reload.type = 'button'; reload.append(icon('i-retry')); ui(reload, 'title', () => t('Reload'));
  const address = document.createElement('input'); address.className = 'workbench-browser-address'; address.type = 'text'; address.spellcheck = false;
  address.autocomplete = 'off'; address.setAttribute('aria-label', t('Address'));
  const agent = el('span', 'workbench-browser-agent'); agent.hidden = true; agent.append(icon('i-bolt'), el('span', '', () => t('Agent control')));
  const tabSelect = document.createElement('select'); tabSelect.className = 'workbench-browser-tabs'; tabSelect.setAttribute('aria-label', t('Browser tab'));
  const add = el('button', 'btn btn-icon') as HTMLButtonElement; add.type = 'button'; add.append(icon('i-plus')); ui(add, 'title', () => t('New tab'));
  const close = el('button', 'btn btn-icon') as HTMLButtonElement; close.type = 'button'; close.append(icon('i-x')); ui(close, 'title', () => t('Close tab'));
  toolbar.append(back, forward, reload, address, agent, tabSelect, add, close);
  const viewport = el('div', 'workbench-browser-viewport');
  viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', t('Browser page'));
  const empty = el('div', 'workbench-browser-empty', () => t('Open a tab to browse a page here.')); viewport.append(empty);
  pane.append(toolbar, viewport);

  let sessionId: string | null = null, state: WorkbenchBrowserState | null = null, shown = false, generation = 0, frame = 0;
  const current = () => state?.tabs.find(tab => tab.id === state?.activeId) ?? null;

  function modalOpen(): boolean { return document.querySelector('dialog[open]') !== null; }
  function visible(): boolean { return shown && !pane.hidden && !modalOpen() && document.visibilityState !== 'hidden'; }
  function schedulePresentation(): void {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { frame = 0; void present(); });
  }
  async function present(): Promise<void> {
    const id = sessionId, tab = current(), token = generation;
    if (!id || !tab || !visible() || !viewport.isConnected) { if (id) void window.api.workbenchBrowserHide(id); return; }
    // A WebContentsView is a native child, not part of the renderer's CSS animation tree. While
    // the right dock is sliding, its DOM viewport moves every frame even when its size is fixed,
    // so ResizeObserver alone cannot keep native bounds aligned. Keep the child hidden during the
    // short drawer motion and present it at the settled geometry instead of letting it float over
    // the chat at the dock's old x coordinate.
    if (pane.closest('.work-dock-right')?.classList.contains('is-moving')) {
      void window.api.workbenchBrowserHide(id); schedulePresentation(); return;
    }
    const rect = viewport.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) { void window.api.workbenchBrowserHide(id); return; }
    await window.api.workbenchBrowserPresent(id, tab.id, { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, true).catch(() => undefined);
    if (token !== generation || id !== sessionId || tab.id !== current()?.id || !visible()) void window.api.workbenchBrowserHide(id);
  }

  function paint(next: WorkbenchBrowserState): void {
    state = next;
    const active = current();
    tabSelect.replaceChildren(...next.tabs.map(tab => {
      const option = document.createElement('option'); option.value = String(tab.id); option.textContent = tab.title || tab.url || t('New tab'); return option;
    }));
    if (active) tabSelect.value = String(active.id);
    tabSelect.disabled = next.tabs.length < 2; close.disabled = !active;
    back.disabled = !active?.canGoBack; forward.disabled = !active?.canGoForward; reload.disabled = !active;
    agent.hidden = !active?.modelControlled; agent.title = active?.modelControlled ? t('The coding agent can interact with this exact tab.') : '';
    empty.hidden = !!active;
    if (active && document.activeElement !== address) address.value = active.url;
    else if (!active && document.activeElement !== address) address.value = '';
    schedulePresentation();
  }

  async function refresh(ensure = false): Promise<void> {
    const id = sessionId, token = ++generation; if (!id) return;
    const reply = ensure ? await run(window.api.workbenchBrowserEnsure(id)) : await run(window.api.workbenchBrowserState(id));
    if (!reply || token !== generation || id !== sessionId) return; paint(reply);
  }

  async function show(): Promise<void> {
    if (!sessionId) return; shown = true; pane.hidden = false; await refresh(true); schedulePresentation();
  }
  function hide(): void { shown = false; pane.hidden = true; if (sessionId) void window.api.workbenchBrowserHide(sessionId); }
  function mountAt(parent: HTMLElement): void { if (pane.parentElement !== parent) parent.append(pane); schedulePresentation(); }
  function sync(next: string | null): void {
    if (next === sessionId) return; const previous = sessionId; sessionId = next; state = null; generation++;
    if (previous) void window.api.workbenchBrowserHide(previous);
    if (!next) { hide(); return; }
    if (shown) void refresh(true);
  }

  const history = async (action: 'back' | 'forward' | 'reload' | 'stop') => {
    const id = sessionId, tab = current(); if (!id || !tab) return;
    const reply = await run(window.api.workbenchBrowserHistory(id, tab.id, action)); if (reply && id === sessionId) paint(reply);
  };
  back.addEventListener('click', () => void history('back')); forward.addEventListener('click', () => void history('forward'));
  reload.addEventListener('click', () => void history(current()?.loading ? 'stop' : 'reload'));
  address.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return; event.preventDefault();
    const id = sessionId, tab = current(), url = address.value.trim(); if (!id || !tab || !url) return;
    void (async () => { const reply = await run(window.api.workbenchBrowserNavigate(id, tab.id, url)); if (reply && id === sessionId) paint(reply); })();
  });
  tabSelect.addEventListener('change', () => {
    const id = sessionId, tabId = Number(tabSelect.value); if (!id || !Number.isSafeInteger(tabId)) return;
    void (async () => { const reply = await run(window.api.workbenchBrowserSelect(id, tabId)); if (reply && id === sessionId) paint(reply); })();
  });
  add.addEventListener('click', () => {
    const id = sessionId; if (!id) return; void (async () => { const reply = await run(window.api.workbenchBrowserNew(id)); if (reply && id === sessionId) paint(reply); })();
  });
  close.addEventListener('click', () => {
    const id = sessionId, tab = current(); if (!id || !tab) return; void (async () => {
      const reply = await run(window.api.workbenchBrowserClose(id, tab.id)); if (!reply || id !== sessionId) return; paint(reply); if (!reply.tabs.length) await refresh(true);
    })();
  });
  pane.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); options.onEscape?.(); } });

  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedulePresentation) : null; resize?.observe(viewport);
  window.addEventListener('resize', schedulePresentation); document.addEventListener('visibilitychange', schedulePresentation);
  const modalObserver = new MutationObserver(schedulePresentation);
  modalObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  window.api.onWorkbenchBrowserChanged?.(change => { if (change.sessionId === sessionId) void refresh(false); });

  return { pane, mountAt, show, hide, sync, visible: () => shown && !pane.hidden };
}
