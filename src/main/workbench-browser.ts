import { randomUUID } from 'node:crypto';
import { app, session, WebContentsView, type BrowserWindow, type Rectangle, type Session } from 'electron';
import { BROWSER_LIMITS, type BrowserCommand, type BrowserResult } from '../shared/browser-control.js';
import { workbenchBrowserContentBounds, type WorkbenchBrowserBounds, type WorkbenchBrowserState, type WorkbenchBrowserTab } from '../shared/workbench-browser.js';
import { browserControl, type InternalBrowserClient } from './browser-control.js';
import { readDurable, writeDurableSoon } from './durable.js';
import { workbenchBrowserBoundedValue, workbenchBrowserPage } from './workbench-browser-page.js';
import { getSession } from './session/store.js';

const PARTITION = 'persist:onecode-workbench-browser';
const BROWSER_NAME = 'OneCode Workbench';
const SESSION_ID = /^[0-9a-z-]{8,64}$/i;
const MAX_TABS = 24;
const STATE_NAME = 'workbench-browser';
interface BrowserRestoreState { version: 1; tabs: Array<{ sessionId: string; url: string; active: boolean }> }

interface BrowserConsoleRow { seq: number; pageId: string; level: string; message: string; url?: string; timestamp: number }
interface BrowserNetworkRow { seq: number; requestId: string; pageId: string; url: string; method?: string; status?: number; mimeType?: string; failed?: string; finished?: boolean }
interface ScreenshotState { id: string; pageId: string; width: number; height: number; scale: number; fullPage: boolean; viewport: Record<string, number> }
interface BrowserTab {
  id: number;
  sessionId: string;
  view: WebContentsView;
  parent: BrowserWindow | null;
  pageId: string;
  frameId: string | null;
  contextId: number | null;
  attached: boolean;
  seq: number;
  console: BrowserConsoleRow[];
  network: Map<string, BrowserNetworkRow>;
  screenshot: ScreenshotState | null;
  dialog: { type: string; message: string; defaultPrompt?: string } | null;
}

function safeUrl(value: string): string {
  const raw = String(value || 'about:blank').trim();
  if (raw === 'about:blank') return raw;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('BROWSER_URL_INVALID'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('BROWSER_URL_UNSUPPORTED: use an HTTP(S) page without embedded credentials.');
  }
  return url.href;
}

function ownerSession(command: BrowserCommand): string | null {
  if (!command.owner.startsWith('session:')) return null;
  const id = command.owner.slice('session:'.length);
  return SESSION_ID.test(id) ? id : null;
}

function boundedRect(value: WorkbenchBrowserBounds, window: BrowserWindow): Rectangle {
  const content = window.getContentBounds();
  return workbenchBrowserContentBounds(value, window.webContents.getZoomFactor(), content);
}

function keyEvent(chord: string): { key: string; code: string; windowsVirtualKeyCode: number; modifiers: number; text?: string } {
  if (!chord) throw new Error('BROWSER_KEY_REQUIRED');
  const parts = chord.split('+'), supplied = parts.at(-1)!; let modifiers = 0;
  for (const name of parts.slice(0, -1)) {
    const bit = ({ control: 2, ctrl: 2, shift: 8, alt: 1, meta: 4, command: 4 } as Record<string, number>)[name.toLowerCase()];
    if (!bit) throw new Error('BROWSER_KEY_INVALID: use Control/Shift/Alt/Meta plus one key.'); modifiers |= bit;
  }
  const aliases: Record<string, string> = { return: 'Enter', esc: 'Escape', spacebar: 'Space', left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' };
  const canonical = aliases[supplied.toLowerCase()] ?? supplied;
  const special: Record<string, [string, number]> = { Enter: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8],
    Delete: ['Delete', 46], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40],
    Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], Space: ['Space', 32] };
  const named = Object.entries(special).find(([name]) => name.toLowerCase() === canonical.toLowerCase())?.[1];
  if (!named && canonical.length !== 1) throw new Error('BROWSER_KEY_INVALID');
  const key = named?.[0] === 'Space' ? ' ' : named?.[0] ?? canonical;
  const code = named?.[0] ?? (/^[a-z]$/i.test(canonical) ? `Key${canonical.toUpperCase()}` : /^\d$/.test(canonical) ? `Digit${canonical}` : '');
  const windowsVirtualKeyCode = named?.[1] ?? canonical.toUpperCase().charCodeAt(0);
  return { key, code, windowsVirtualKeyCode, modifiers, ...(!(modifiers & 7) && (key.length === 1 || key === 'Enter') ? { text: key === 'Enter' ? '\r' : key } : {}) };
}

export class WorkbenchBrowserController {
  private readonly browserId = randomUUID();
  private readonly ses: Session;
  private readonly tabs = new Map<number, BrowserTab>();
  private readonly active = new Map<string, number>();
  private readonly listeners = new Set<(sessionId: string) => void>();
  private unregisterClient: (() => void) | null = null;
  private presentation: { sessionId: string; tabId: number; bounds: WorkbenchBrowserBounds; visible: boolean } | null = null;
  private readonly restored = new Map<string, Array<{ url: string; active: boolean }>>();
  private readonly restorePromise: Promise<void>;
  private disposing = false;

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    this.ses = session.fromPartition(PARTITION);
    this.ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.ses.setPermissionCheckHandler(() => false);
    this.ses.on('will-download', event => event.preventDefault());
    this.restorePromise = this.restoreMetadata();
    app.once('before-quit', () => this.dispose());
  }

  onChange(listener: (sessionId: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(sessionId: string): void { for (const listener of this.listeners) listener(sessionId); }

  private ensureClient(): void {
    if (this.unregisterClient || !this.tabs.size) return;
    const client: InternalBrowserClient = { id: this.browserId, name: BROWSER_NAME, enabled: true, execute: (command, allowed) => this.execute(command, allowed) };
    this.unregisterClient = browserControl.registerInternalClient(client);
  }
  private retireClient(): void { if (this.tabs.size || !this.unregisterClient) return; this.unregisterClient(); this.unregisterClient = null; }

  state(sessionId: string): WorkbenchBrowserState {
    if (!SESSION_ID.test(sessionId)) throw new Error('Invalid session id');
    const tabs = [...this.tabs.values()].filter(tab => tab.sessionId === sessionId).map(tab => this.publicTab(tab));
    const active = this.active.get(sessionId);
    return { sessionId, tabs, activeId: active && tabs.some(tab => tab.id === active) ? active : tabs[0]?.id ?? null };
  }

  private publicTab(tab: BrowserTab): WorkbenchBrowserTab {
    const contents = tab.view.webContents;
    return { id: tab.id, sessionId: tab.sessionId, title: contents.getTitle() || contents.getURL() || 'New tab',
      url: contents.getURL() || 'about:blank', loading: contents.isLoading(), canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(), modelControlled: tab.attached };
  }

  async ensure(sessionId: string, url = 'about:blank'): Promise<WorkbenchBrowserState> {
    await this.restorePromise;
    const current = this.state(sessionId);
    if (!current.tabs.length) {
      const restored = this.restored.get(sessionId); this.restored.delete(sessionId);
      if (restored?.length) for (const entry of restored.slice(0, MAX_TABS)) this.createTab(sessionId, entry.url, entry.active);
      else this.createTab(sessionId, url, true);
    }
    return this.state(sessionId);
  }

  newTab(sessionId: string, url = 'about:blank'): WorkbenchBrowserState { this.createTab(sessionId, url, true); return this.state(sessionId); }

  select(sessionId: string, tabId: number): WorkbenchBrowserState {
    const tab = this.requireTab(sessionId, tabId); this.active.set(sessionId, tab.id); this.syncPresentation(); this.notify(sessionId); return this.state(sessionId);
  }

  close(sessionId: string, tabId: number): WorkbenchBrowserState {
    const tab = this.requireTab(sessionId, tabId); this.destroyTab(tab); return this.state(sessionId);
  }

  navigate(sessionId: string, tabId: number, value: string): WorkbenchBrowserState {
    const tab = this.requireTab(sessionId, tabId); const url = safeUrl(value); void tab.view.webContents.loadURL(url).catch(() => undefined); return this.state(sessionId);
  }

  history(sessionId: string, tabId: number, action: 'back' | 'forward' | 'reload' | 'stop'): WorkbenchBrowserState {
    const tab = this.requireTab(sessionId, tabId), contents = tab.view.webContents;
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (action === 'reload') contents.reload();
    else if (action === 'stop') contents.stop();
    return this.state(sessionId);
  }

  present(sessionId: string, tabId: number, bounds: WorkbenchBrowserBounds, visible: boolean): WorkbenchBrowserState {
    const tab = this.requireTab(sessionId, tabId); this.active.set(sessionId, tab.id);
    this.presentation = { sessionId, tabId, bounds, visible }; this.syncPresentation(); return this.state(sessionId);
  }

  hide(sessionId?: string): void {
    if (!this.presentation || (sessionId && this.presentation.sessionId !== sessionId)) return;
    this.presentation.visible = false; this.syncPresentation();
  }

  dispose(): void {
    this.presentation = null; this.disposing = true;
    for (const tab of [...this.tabs.values()]) this.destroyTab(tab);
    this.unregisterClient?.(); this.unregisterClient = null; this.listeners.clear();
  }

  private createTab(sessionId: string, requested: string, activate: boolean): BrowserTab {
    if (!SESSION_ID.test(sessionId)) throw new Error('Invalid session id');
    if (this.tabs.size >= MAX_TABS) throw new Error('Workbench browser tab limit reached');
    const url = safeUrl(requested);
    const view = new WebContentsView({ webPreferences: { session: this.ses, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    view.setVisible(false); view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const tab: BrowserTab = { id: view.webContents.id, sessionId, view, parent: null, pageId: randomUUID(), frameId: null, contextId: null, attached: false,
      seq: 0, console: [], network: new Map(), screenshot: null, dialog: null };
    this.tabs.set(tab.id, tab); if (activate || !this.active.has(sessionId)) this.active.set(sessionId, tab.id);
    view.webContents.on('will-navigate', (event, next) => { try { safeUrl(next); } catch { event.preventDefault(); } });
    view.webContents.on('did-start-loading', () => this.notify(sessionId));
    view.webContents.on('did-stop-loading', () => { this.persistMetadata(); this.notify(sessionId); });
    view.webContents.on('page-title-updated', () => this.notify(sessionId));
    view.webContents.on('did-start-navigation', (_event, _url, _same, main) => { if (main) this.invalidate(tab); });
    view.webContents.on('did-navigate-in-page', () => this.invalidate(tab));
    view.webContents.on('render-process-gone', () => { this.invalidate(tab); this.notify(sessionId); });
    view.webContents.debugger.on('message', (_event, method, params, childSessionId) => this.debuggerEvent(tab, method, params as Record<string, any>, childSessionId));
    view.webContents.debugger.on('detach', () => { if (tab.attached) { tab.attached = false; tab.contextId = null; tab.frameId = null; this.notify(sessionId); } });
    this.ensureClient(); this.attachParent(tab); void view.webContents.loadURL(url).catch(() => undefined); this.persistMetadata(); this.syncPresentation(); this.notify(sessionId);
    return tab;
  }

  private attachParent(tab: BrowserTab): void {
    const window = this.getWindow(); if (!window || window.isDestroyed() || tab.parent === window) return;
    if (tab.parent && !tab.parent.isDestroyed()) tab.parent.contentView.removeChildView(tab.view);
    window.contentView.addChildView(tab.view); tab.parent = window;
  }

  private destroyTab(tab: BrowserTab): void {
    if (!this.tabs.has(tab.id)) return;
    this.tabs.delete(tab.id);
    if (tab.parent && !tab.parent.isDestroyed()) tab.parent.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (this.active.get(tab.sessionId) === tab.id) {
      const next = [...this.tabs.values()].find(candidate => candidate.sessionId === tab.sessionId);
      if (next) this.active.set(tab.sessionId, next.id); else this.active.delete(tab.sessionId);
    }
    if (this.presentation?.tabId === tab.id) this.presentation = null;
    this.persistMetadata(); this.syncPresentation(); this.notify(tab.sessionId); this.retireClient();
  }

  private requireTab(sessionId: string, tabId: number): BrowserTab {
    const tab = this.tabs.get(tabId); if (!tab || tab.sessionId !== sessionId) throw new Error('Workbench browser tab was not found'); return tab;
  }

  private syncPresentation(): void {
    const presentation = this.presentation, window = this.getWindow();
    for (const tab of this.tabs.values()) {
      this.attachParent(tab);
      const visible = !!presentation?.visible && presentation.tabId === tab.id && presentation.sessionId === tab.sessionId && !!window && !window.isDestroyed();
      if (visible && window) tab.view.setBounds(boundedRect(presentation!.bounds, window));
      tab.view.setVisible(visible);
    }
  }

  private invalidate(tab: BrowserTab): void { tab.pageId = randomUUID(); tab.contextId = null; tab.frameId = null; tab.screenshot = null; tab.dialog = null; }

  private async restoreMetadata(): Promise<void> {
    const saved = await readDurable<unknown>(STATE_NAME);
    if (!saved || typeof saved !== 'object' || (saved as Partial<BrowserRestoreState>).version !== 1 || !Array.isArray((saved as BrowserRestoreState).tabs)) return;
    for (const entry of (saved as BrowserRestoreState).tabs.slice(0, MAX_TABS)) {
      if (!entry || !SESSION_ID.test(entry.sessionId) || typeof entry.url !== 'string' || typeof entry.active !== 'boolean') continue;
      try { safeUrl(entry.url); } catch { continue; }
      if (!await getSession(entry.sessionId)) continue;
      const rows = this.restored.get(entry.sessionId) ?? []; rows.push({ url: entry.url, active: entry.active }); this.restored.set(entry.sessionId, rows);
    }
  }

  private persistMetadata(): void {
    if (this.disposing) return;
    const liveSessions = new Set([...this.tabs.values()].map(tab => tab.sessionId));
    const tabs: BrowserRestoreState['tabs'] = [];
    for (const [sessionId, entries] of this.restored) if (!liveSessions.has(sessionId)) {
      for (const entry of entries) tabs.push({ sessionId, url: entry.url, active: entry.active });
    }
    for (const tab of this.tabs.values()) {
      const raw = tab.view.webContents.getURL() || 'about:blank'; let url: string; try { url = safeUrl(raw); } catch { continue; }
      tabs.push({ sessionId: tab.sessionId, url, active: this.active.get(tab.sessionId) === tab.id });
    }
    writeDurableSoon(STATE_NAME, { version: 1, tabs: tabs.slice(0, MAX_TABS) } satisfies BrowserRestoreState);
  }

  private async authorize(command: BrowserCommand, allowed: () => Promise<boolean>): Promise<void> {
    if (command.expiresAt <= Date.now() || !await allowed().catch(() => false)) throw new Error('BROWSER_PERMISSION_REVOKED: remaining input was not dispatched.');
  }

  private modelTab(command: BrowserCommand, requireAttached = true): BrowserTab {
    const sessionId = ownerSession(command); if (!sessionId) throw new Error('BROWSER_IDENTITY_REQUIRED: Workbench tabs require an exact session owner.');
    const id = Number(command.args.tabId); const tab = this.tabs.get(id);
    if (!tab || tab.sessionId !== sessionId) throw new Error('BROWSER_TAB_NOT_FOUND: this Workbench tab does not belong to the calling session.');
    if (requireAttached && !tab.attached) throw new Error('BROWSER_TAB_NOT_OWNED: attach this exact Workbench tab before interaction.');
    if (command.args.pageId && command.args.pageId !== tab.pageId) throw new Error('BROWSER_PAGE_STALE: navigation invalidated the observation. Snapshot again.');
    return tab;
  }

  private async send(tab: BrowserTab, method: string, params: object = {}, childSessionId?: string): Promise<any> {
    if (!tab.attached || !tab.view.webContents.debugger.isAttached()) throw new Error('BROWSER_DETACHED');
    return tab.view.webContents.debugger.sendCommand(method, params, childSessionId);
  }

  private async attach(tab: BrowserTab, command: BrowserCommand, allowed: () => Promise<boolean>): Promise<void> {
    await this.authorize(command, allowed);
    if (!tab.attached) {
      if (tab.view.webContents.debugger.isAttached()) throw new Error('BROWSER_TAB_OWNED: another debugger owns this Workbench tab.');
      tab.view.webContents.debugger.attach('1.3'); tab.attached = true;
      try {
        await this.send(tab, 'Page.enable'); await this.send(tab, 'Runtime.enable');
        await this.send(tab, 'Network.enable', { maxTotalBufferSize: 2_000_000, maxResourceBufferSize: 500_000, maxPostDataSize: 16000 });
        await this.send(tab, 'Log.enable'); await this.send(tab, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      } catch (error) { try { tab.view.webContents.debugger.detach(); } catch { /* already gone */ } tab.attached = false; throw error; }
      this.invalidate(tab); this.notify(tab.sessionId);
    }
  }

  private async release(tab: BrowserTab): Promise<void> {
    if (tab.view.webContents.debugger.isAttached()) { try { tab.view.webContents.debugger.detach(); } catch { /* already gone */ } }
    tab.attached = false; tab.contextId = null; tab.frameId = null; tab.screenshot = null; this.notify(tab.sessionId);
  }

  private async isolatedContext(tab: BrowserTab): Promise<{ id: number; frameId: string }> {
    if (tab.contextId && tab.frameId) return { id: tab.contextId, frameId: tab.frameId };
    const tree = await this.send(tab, 'Page.getFrameTree'); const frameId = tree.frameTree?.frame?.id;
    if (!frameId) throw new Error('BROWSER_FRAME_UNAVAILABLE');
    const world = await this.send(tab, 'Page.createIsolatedWorld', { frameId, worldName: `onecode-workbench-${tab.pageId}`, grantUniveralAccess: false });
    if (!Number.isInteger(world.executionContextId)) throw new Error('BROWSER_FRAME_UNAVAILABLE');
    tab.contextId = world.executionContextId; tab.frameId = frameId; return { id: tab.contextId!, frameId };
  }

  private async page(tab: BrowserTab, operation: string, args: Record<string, unknown>): Promise<any> {
    const context = await this.isolatedContext(tab);
    if (args.frameId && args.frameId !== context.frameId) throw new Error('BROWSER_FRAME_UNAVAILABLE: this Workbench browser currently exposes the top document only.');
    const expression = `(${workbenchBrowserPage.toString()})(${JSON.stringify(operation)},${JSON.stringify({ ...args, pageId: tab.pageId })})`;
    const result = await this.send(tab, 'Runtime.evaluate', { expression, contextId: context.id, returnByValue: true, awaitPromise: true, timeout: 5000 });
    if (result.exceptionDetails) throw new Error(`BROWSER_JAVASCRIPT_ERROR: ${String(result.exceptionDetails.exception?.description || result.exceptionDetails.text).slice(0, 1200)}`);
    return result.result?.value;
  }

  private async snapshot(tab: BrowserTab, args: Record<string, unknown>): Promise<BrowserResult> {
    const context = await this.isolatedContext(tab);
    const value = await this.page(tab, 'snapshot', args);
    return { value: { ...value, tabId: `${this.browserId}:${tab.id}`, pageId: tab.pageId, frameId: context.frameId,
      frames: [{ frameId: context.frameId, url: tab.view.webContents.getURL() }], dialog: tab.dialog } };
  }

  private async screenshot(tab: BrowserTab, args: Record<string, unknown>, command: BrowserCommand): Promise<BrowserResult> {
    const pageId = tab.pageId; const metrics = await this.send(tab, 'Page.getLayoutMetrics');
    const viewport = metrics.cssVisualViewport;
    const rect = args.fullPage === true ? metrics.cssContentSize : { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight };
    if (!(rect.width > 0 && rect.height > 0) || rect.width > 100000 || rect.height > 100000) throw new Error('BROWSER_CAPTURE_DIMENSIONS');
    const scale = Math.min(1, 1600 / Math.max(rect.width, rect.height));
    const width = Math.round(rect.width * scale), height = Math.round(rect.height * scale);
    const result = await this.send(tab, 'Page.captureScreenshot', { format: 'jpeg', quality: 80, fromSurface: true,
      captureBeyondViewport: args.fullPage === true, clip: { ...rect, scale } });
    if (command.expiresAt <= Date.now() || tab.pageId !== pageId) throw new Error('BROWSER_PAGE_STALE: screenshot crossed navigation.');
    if (!result.data || result.data.length > Math.ceil(BROWSER_LIMITS.imageBytes * 4 / 3)) throw new Error('BROWSER_SCREENSHOT_TOO_LARGE');
    const shot: ScreenshotState = { id: randomUUID(), pageId, width, height, scale, viewport, fullPage: args.fullPage === true }; tab.screenshot = shot;
    return { value: { tabId: `${this.browserId}:${tab.id}`, pageId, screenshotId: shot.id, width, height, scale, fullPage: shot.fullPage },
      image: { mimeType: 'image/jpeg', data: result.data } };
  }

  private async point(tab: BrowserTab, args: Record<string, unknown>): Promise<{ x: number; y: number }> {
    if (typeof args.ref === 'string') return this.page(tab, 'point', { ref: args.ref });
    const shot = tab.screenshot;
    if (!shot || shot.pageId !== tab.pageId || shot.id !== args.screenshotId || shot.fullPage ||
        !Number.isFinite(args.x) || !Number.isFinite(args.y)) throw new Error('BROWSER_SCREENSHOT_STALE: coordinate input needs a current viewport screenshotId and x/y.');
    const x = Number(args.x), y = Number(args.y);
    if (x < 0 || y < 0 || x >= shot.width || y >= shot.height) throw new Error('BROWSER_COORDINATES_OUTSIDE_IMAGE');
    return { x: x / shot.scale, y: y / shot.scale };
  }

  private async action(tab: BrowserTab, args: Record<string, unknown>, command: BrowserCommand, allowed: () => Promise<boolean>): Promise<BrowserResult> {
    await this.authorize(command, allowed); const action = String(args.action);
    if (action === 'dialog') {
      if (typeof args.accept !== 'boolean' || !tab.dialog) throw new Error('BROWSER_DIALOG_REQUIRED');
      await this.send(tab, 'Page.handleJavaScriptDialog', { accept: args.accept, promptText: typeof args.text === 'string' ? args.text : '' });
    } else if (action === 'key') {
      const key = keyEvent(String(args.key ?? ''));
      if (args.ref) await this.page(tab, 'focus', { ref: args.ref, keyTarget: true });
      await this.send(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key });
      const { text: _text, ...up } = key;
      try { if (Number(args.holdMs) > 0) await new Promise(resolve => setTimeout(resolve, Math.min(2000, Number(args.holdMs)))); }
      finally { await this.send(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...up }).catch(() => undefined); }
    } else if (action === 'fill' || action === 'type') {
      if (typeof args.text !== 'string' || typeof args.ref !== 'string') throw new Error('BROWSER_TEXT_TARGET_REQUIRED');
      await this.page(tab, 'focus', { ref: args.ref, replace: action === 'fill' });
      if (action === 'fill' && !args.text) {
        await this.send(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await this.send(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      } else await this.send(tab, 'Input.insertText', { text: args.text });
    } else if (action === 'select') {
      await this.page(tab, 'select', { ref: args.ref, values: args.values });
    } else {
      const from = await this.point(tab, args);
      if (action === 'scroll') await this.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...from, deltaX: Number(args.deltaX) || 0, deltaY: Number(args.deltaY) || 0 });
      else {
        await this.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
        if (action === 'click') {
          const button = typeof args.button === 'string' ? args.button : 'left'; const count = Math.max(1, Math.min(3, Number(args.clickCount) || 1));
          for (let click = 1; click <= count; click++) {
            await this.send(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button, clickCount: click });
            await this.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...from, button, clickCount: click });
          }
        } else if (action === 'drag') {
          const to = await this.point(tab, { ref: args.toRef, x: args.toX, y: args.toY, screenshotId: args.screenshotId });
          await this.send(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 });
          try {
            for (let step = 1; step <= 10; step++) await this.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * step / 10,
              y: from.y + (to.y - from.y) * step / 10, button: 'left', buttons: 1 });
          } finally { await this.send(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 }).catch(() => undefined); }
        } else if (action !== 'hover') throw new Error('BROWSER_ACTION_UNKNOWN');
      }
    }
    tab.screenshot = null;
    return { value: { tabId: `${this.browserId}:${tab.id}`, pageId: tab.pageId, accepted: true, message: 'Input dispatched; observe the page to verify the effect.' } };
  }

  private diagnostics(tab: BrowserTab, tool: string, args: Record<string, unknown>): BrowserResult {
    const network = tool === 'browser_network';
    if (network && typeof args.requestId === 'string') {
      const row = tab.network.get(args.requestId); if (!row) throw new Error('BROWSER_REQUEST_EXPIRED'); return { value: row };
    }
    const after = Number(args.after) || 0, limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
    const filter = typeof args.filter === 'string' ? args.filter.toLowerCase() : '';
    const rows: Array<BrowserConsoleRow | BrowserNetworkRow> = network
      ? [...tab.network.values()].filter(row => row.seq > after && (!filter || JSON.stringify(row).toLowerCase().includes(filter)))
      : tab.console.filter(row => row.seq > after && (!filter || JSON.stringify(row).toLowerCase().includes(filter)) &&
        (!args.level || args.level === 'all' || row.level === args.level));
    rows.sort((a, b) => a.seq - b.seq);
    const entries = rows.slice(0, limit);
    if (args.clear === true) { if (network) tab.network.clear(); else tab.console = []; }
    return { value: { entries, nextCursor: entries.at(-1)?.seq ?? after, truncated: entries.length < rows.length, capture: 'Since Workbench browser attachment.' } };
  }

  private async evaluate(tab: BrowserTab, args: Record<string, unknown>, command: BrowserCommand, allowed: () => Promise<boolean>): Promise<BrowserResult> {
    await this.authorize(command, allowed);
    if (args.frameId && args.frameId !== tab.frameId) throw new Error('BROWSER_FRAME_UNAVAILABLE: this Workbench browser currently exposes the top document only.');
    const expression = `(async()=>{const value=await (${String(args.expression)});return (${workbenchBrowserBoundedValue.toString()})(value);})()`;
    const result = await this.send(tab, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 5000 });
    if (result.exceptionDetails) throw new Error(`BROWSER_JAVASCRIPT_ERROR: ${String(result.exceptionDetails.exception?.description || result.exceptionDetails.text).slice(0, 1200)}`);
    tab.screenshot = null; return { value: { tabId: `${this.browserId}:${tab.id}`, pageId: tab.pageId, ...(result.result?.value ?? {}) } };
  }

  private listTabs(command: BrowserCommand): BrowserResult {
    const sessionId = ownerSession(command); if (!sessionId) return { value: { browserId: this.browserId, tabs: [], total: 0, truncated: false, nextOffset: null } };
    const filter = String(command.args.filter ?? '').toLowerCase(), offset = Number(command.args.offset) || 0, limit = Number(command.args.limit) || 100;
    const owned = [...this.tabs.values()].filter(tab => tab.sessionId === sessionId).filter(tab => !filter || `${tab.view.webContents.getTitle()} ${tab.view.webContents.getURL()}`.toLowerCase().includes(filter));
    const values = owned.slice(offset, offset + limit).map(tab => ({ tabId: `${this.browserId}:${tab.id}`, title: this.publicTab(tab).title, url: this.publicTab(tab).url,
      active: this.active.get(sessionId) === tab.id, pinned: false, status: tab.view.webContents.isLoading() ? 'loading' : 'complete', owned: tab.attached, claimed: tab.attached, protected: false,
      access: { snapshot: tab.attached ? 'interactive' : 'attach-required', input: tab.attached ? 'available' : 'attach-required' } }));
    const nextOffset = offset + values.length; return { value: { browserId: this.browserId, tabs: values, total: owned.length, truncated: nextOffset < owned.length,
      nextOffset: nextOffset < owned.length ? nextOffset : null, guidance: 'These are app-owned Workbench browser tabs for this exact OneCode session.' } };
  }

  private async execute(command: BrowserCommand, allowed: () => Promise<boolean>): Promise<BrowserResult> {
    try {
      if (command.expiresAt <= Date.now()) throw new Error('BROWSER_EXPIRED: no operation dispatched.');
      const { tool, args } = command;
      if (tool === 'browser_tabs') {
        if (args.action === 'list') return this.listTabs(command);
        const sessionId = ownerSession(command); if (!sessionId) throw new Error('BROWSER_IDENTITY_REQUIRED');
        if (args.action === 'new') {
          await this.authorize(command, allowed); const tab = this.createTab(sessionId, safeUrl(String(args.url ?? 'about:blank')), false); await this.attach(tab, command, allowed);
          return { value: { tabId: `${this.browserId}:${tab.id}`, pageId: tab.pageId, url: tab.view.webContents.getURL() || String(args.url ?? 'about:blank'),
            title: tab.view.webContents.getTitle(), attached: true, created: true, navigationRequested: String(args.url ?? 'about:blank') } };
        }
        const tab = this.modelTab(command, false);
        if (args.action === 'attach') { await this.attach(tab, command, allowed); return { value: { tabId: `${this.browserId}:${tab.id}`, pageId: tab.pageId, url: tab.view.webContents.getURL(), title: tab.view.webContents.getTitle(), attached: true } }; }
        if (args.action === 'release') { if (!tab.attached) throw new Error('BROWSER_TAB_NOT_OWNED'); await this.release(tab); return { value: { tabId: `${this.browserId}:${tab.id}`, released: true } }; }
        if (args.action === 'close') { if (!tab.attached) throw new Error('BROWSER_TAB_NOT_OWNED'); await this.authorize(command, allowed); this.destroyTab(tab); return { value: { tabId: `${this.browserId}:${tab.id}`, closed: true } }; }
        throw new Error('BROWSER_TABS_ACTION_UNKNOWN');
      }
      const tab = this.modelTab(command);
      if (tool === 'browser_snapshot') return this.snapshot(tab, args);
      if (tool === 'browser_screenshot') return this.screenshot(tab, args, command);
      if (tool === 'browser_action') return this.action(tab, args, command, allowed);
      if (tool === 'browser_evaluate') return this.evaluate(tab, args, command, allowed);
      if (tool === 'browser_console' || tool === 'browser_network') return this.diagnostics(tab, tool, args);
      if (tool === 'browser_navigate') {
        await this.authorize(command, allowed);
        if (args.action === 'url') await this.send(tab, 'Page.navigate', { url: safeUrl(String(args.url ?? '')) });
        else if (args.action === 'reload') await this.send(tab, 'Page.reload');
        else {
          const history = await this.send(tab, 'Page.getNavigationHistory'); const delta = args.action === 'back' ? -1 : 1; const next = history.entries?.[history.currentIndex + delta];
          if (!next) throw new Error('BROWSER_HISTORY_EMPTY'); await this.send(tab, 'Page.navigateToHistoryEntry', { entryId: next.id });
        }
        this.invalidate(tab); return { value: { tabId: `${this.browserId}:${tab.id}`, accepted: true, message: 'Navigation requested. Snapshot again when the destination loads.' } };
      }
      throw new Error('BROWSER_TOOL_UNKNOWN');
    } catch (error) { return { error: error instanceof Error ? error.message.slice(0, 1500) : String(error).slice(0, 1500) }; }
  }

  private debuggerEvent(tab: BrowserTab, method: string, params: Record<string, any>, childSessionId?: string): void {
    if (!this.tabs.has(tab.id)) return;
    if (method === 'Page.frameNavigated' && !params.frame?.parentId && !childSessionId) this.invalidate(tab);
    else if (method === 'Page.navigatedWithinDocument' && !childSessionId) this.invalidate(tab);
    else if (method === 'Page.javascriptDialogOpening') tab.dialog = { type: String(params.type ?? ''), message: String(params.message ?? '').slice(0, 2000), defaultPrompt: String(params.defaultPrompt ?? '').slice(0, 1000) };
    else if (method === 'Page.javascriptDialogClosed') tab.dialog = null;
    else if (['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded'].includes(method)) {
      const data = params.exceptionDetails || params.entry || params; let level = params.exceptionDetails ? 'error' : String(data.level || data.type || 'info');
      level = ({ warn: 'warning', log: 'info', verbose: 'debug' } as Record<string, string>)[level] ?? level;
      const message = params.args ? params.args.slice(0, 10).map((arg: Record<string, unknown>) => String(arg.value ?? arg.description ?? arg.type).slice(0, 1200)).join(' ')
        : String(data.exception?.description || data.text || '').slice(0, 3000);
      tab.console.push({ seq: ++tab.seq, pageId: tab.pageId, level, message, url: String(data.url ?? '').slice(0, 1000), timestamp: Date.now() });
      if (tab.console.length > 200) tab.console.shift();
    } else if (method === 'Network.requestWillBeSent' && params.requestId) {
      const id = `${childSessionId || 'main'}:${params.requestId}`; tab.network.set(id, { seq: ++tab.seq, requestId: id, pageId: tab.pageId,
        url: String(params.request?.url ?? '').slice(0, 2000), method: String(params.request?.method ?? '').slice(0, 20) }); if (tab.network.size > 200) tab.network.delete(tab.network.keys().next().value!);
    } else if (method === 'Network.responseReceived' && params.requestId) {
      const id = `${childSessionId || 'main'}:${params.requestId}`, row = tab.network.get(id); if (row) Object.assign(row, { seq: ++tab.seq, status: params.response?.status, mimeType: String(params.response?.mimeType ?? '').slice(0, 100) });
    } else if (method === 'Network.loadingFinished' && params.requestId) {
      const row = tab.network.get(`${childSessionId || 'main'}:${params.requestId}`); if (row) Object.assign(row, { seq: ++tab.seq, finished: true });
    } else if (method === 'Network.loadingFailed' && params.requestId) {
      const row = tab.network.get(`${childSessionId || 'main'}:${params.requestId}`); if (row) Object.assign(row, { seq: ++tab.seq, finished: true, failed: String(params.errorText ?? '').slice(0, 1000) });
    }
    this.notify(tab.sessionId);
  }
}
