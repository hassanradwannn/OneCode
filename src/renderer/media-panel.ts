import type { NativeMediaItem, NativeVideoPlayback } from '../shared/native-media.js';
import { el, icon, run, toast } from './dom.js';
import { t, ui } from './i18n.js';

const keyOf = (item: NativeMediaItem): string => `${item.messageId}\u0000${item.providerAssetId}`;
const playbackKeyOf = (sessionId: string, item: NativeMediaItem): string => `${sessionId}\u0000${keyOf(item)}`;

function unavailableText(item: NativeMediaItem): string {
  if (item.previewStatus === 'pending') return t('Preview is loading');
  if (item.previewError === 'removed') return t('Preview removed from local storage');
  if (item.previewError === 'quota') return t('Preview unavailable — recording storage is full');
  if (item.previewError === 'oversized') return t('Preview unavailable — media exceeds the recording limit');
  if (item.previewError === 'not_mounted') return t('Preview unavailable — show this media in the provider page to retry');
  if (item.previewError === 'not_loaded') return t('Preview unavailable — provider media is still loading');
  if (item.previewError === 'ambiguous') return t('Preview unavailable — the browser could not match this media safely');
  if (item.previewError === 'tainted') return t('Preview unavailable — the browser blocked preview capture');
  if (item.previewError === 'invalid') return t('Preview unavailable — the captured preview was invalid');
  return t('Preview unavailable');
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value), out = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let i = 0; i < decoded.length; i++) out[i] = decoded.charCodeAt(i);
  return out;
}

export function createMediaPanel(options: { onAvailabilityChanged?: () => void; onEscape?: () => void }) {
  const pane = el('section', 'media-panel'); pane.hidden = true;
  const toolbar = el('div', 'media-panel-toolbar');
  const title = el('strong', 'media-panel-title', () => t('Media'));
  const count = el('span', 'meta media-panel-count');
  const refreshButton = el('button', 'btn btn-icon') as HTMLButtonElement; refreshButton.type = 'button'; refreshButton.append(icon('i-retry')); ui(refreshButton, 'title', () => t('Refresh'));
  toolbar.append(title, count, refreshButton);
  const body = el('div', 'media-panel-body');
  const list = el('div', 'media-panel-list'); list.setAttribute('role', 'listbox');
  const detail = el('div', 'media-panel-detail'); body.append(list, detail); pane.append(toolbar, body);

  let sessionId: string | null = null, items: NativeMediaItem[] = [], selected = '', generation = 0, shown = false;
  let playbackUrl: string | null = null, playbackKey = '';
  const available = () => !!sessionId && items.length > 0;
  const current = () => items.find(item => keyOf(item) === selected) ?? items[0] ?? null;
  function retirePlayback(): void { if (playbackUrl) URL.revokeObjectURL(playbackUrl); playbackUrl = null; playbackKey = ''; }

  async function loadPreview(item: NativeMediaItem, host: HTMLElement, token: number): Promise<void> {
    if (!item.asset || !sessionId) { host.replaceChildren(el('p', 'meta media-preview-unavailable', () => unavailableText(item))); return; }
    host.replaceChildren(el('p', 'meta', () => t('Loading preview…')));
    const data = await run(window.api.getSessionImage(sessionId, item.asset.id));
    if (token !== generation || !host.isConnected || keyOf(item) !== selected) return;
    if (!data) { host.replaceChildren(el('p', 'meta media-preview-unavailable', () => unavailableText({ ...item, previewStatus: 'unavailable' }))); return; }
    const image = document.createElement('img'); image.src = data; image.alt = item.kind === 'video' ? t('Generated video poster') : t('Generated image');
    host.replaceChildren(image);
  }

  async function loadVideo(item: NativeMediaItem, host: HTMLElement, button: HTMLButtonElement, token: number): Promise<void> {
    const owner = sessionId; if (!owner || item.kind !== 'video') return; button.disabled = true; button.textContent = t('Loading video…');
    const current = () => token === generation && owner === sessionId && keyOf(item) === selected && host.isConnected && shown;
    let playback: NativeVideoPlayback | null = null;
    try {
      const reply = await window.api.prepareNativeVideoPlayback(owner, item.messageId, item.providerAssetId);
      if (!reply.ok) { toast(reply.error); return; } playback = reply.data;
      if (!current()) return;
      const parts: BlobPart[] = []; let offset = 0;
      while (offset < playback.bytes) {
        const chunk = await window.api.readNativeVideoPlaybackChunk(owner, playback.token, offset, 1024 * 1024);
        if (!chunk.ok) { toast(chunk.error); return; }
        if (!current()) return;
        if (chunk.data.totalBytes !== playback.bytes || chunk.data.offset !== offset || chunk.data.nextOffset <= offset || chunk.data.nextOffset > playback.bytes)
          throw new Error('Video transfer did not make valid progress.');
        if (chunk.data.data) parts.push(decodeBase64(chunk.data.data).buffer); offset = chunk.data.nextOffset;
        button.textContent = t('Loading video… {0}', [`${Math.min(100, Math.round(offset / playback.bytes * 100))}%`]);
        if (chunk.data.done) break;
      }
      if (!current()) return;
      if (offset !== playback.bytes) { toast(t('Video transfer ended early.')); return; }
      retirePlayback(); playbackUrl = URL.createObjectURL(new Blob(parts, { type: playback.mimeType })); playbackKey = playbackKeyOf(owner, item);
      const video = document.createElement('video'); video.controls = true; video.preload = 'metadata'; video.src = playbackUrl;
      video.setAttribute('aria-label', t('Generated video')); host.replaceChildren(video); void video.play().catch(() => undefined);
    } catch (error) {
      if (current()) toast(t('Video could not be loaded: {0}', [(error as Error).message]));
    } finally {
      if (playback?.token) void window.api.releaseNativeVideoPlayback(owner, playback.token);
      button.disabled = false; button.textContent = t('Load original');
    }
  }

  function renderList(): void {
    list.replaceChildren(); count.textContent = items.length ? t('{0} items', [items.length]) : '';
    for (const item of items) {
      const button = el('button', `media-list-item${keyOf(item) === selected ? ' is-selected' : ''}`) as HTMLButtonElement; button.type = 'button'; button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(keyOf(item) === selected)); button.dataset.key = keyOf(item);
      button.append(icon(item.kind === 'video' ? 'i-play' : 'i-image'), el('span', 'media-list-label', item.kind === 'video' ? t('Video') : t('Image')),
        el('span', 'media-list-meta', `${item.messageId.slice(0, 8)} · ${item.providerAssetId.slice(-10)}`));
      button.addEventListener('click', () => { selected = keyOf(item); retirePlayback(); render(); }); list.append(button);
    }
  }

  function renderDetail(): void {
    detail.replaceChildren(); const item = current(); if (!item) { detail.append(el('p', 'meta media-panel-empty', () => t('No generated media recorded in this chat.'))); return; }
    selected = keyOf(item); const token = generation;
    const head = el('div', 'media-detail-head');
    const heading = el('div', 'media-detail-title'); heading.append(icon(item.kind === 'video' ? 'i-play' : 'i-image'), el('strong', '', item.kind === 'video' ? t('Generated video') : t('Generated image')));
    const actions = el('div', 'media-detail-actions');
    const save = el('button', 'btn media-action') as HTMLButtonElement; save.type = 'button'; save.append(icon('i-out'), el('span', '', () => t('Save to project')));
    const reveal = el('button', 'btn media-action') as HTMLButtonElement; reveal.type = 'button'; reveal.append(icon('i-browser'), el('span', '', () => t('Open provider')));
    actions.append(save, reveal); head.append(heading, actions);
    const stage = el('div', `media-stage is-${item.kind}`);
    const ratioWidth = item.width ?? item.previewWidth ?? 16, ratioHeight = item.height ?? item.previewHeight ?? 9; stage.style.aspectRatio = `${Math.max(1, ratioWidth)} / ${Math.max(1, ratioHeight)}`;
    if (item.kind === 'video' && sessionId && playbackUrl && playbackKey === playbackKeyOf(sessionId, item)) { const video = document.createElement('video'); video.controls = true; video.src = playbackUrl; stage.append(video); }
    else void loadPreview(item, stage, token);
    const meta = el('div', 'media-detail-meta');
    const dims = item.width && item.height ? `${item.width}×${item.height}` : item.previewWidth && item.previewHeight ? `${item.previewWidth}×${item.previewHeight} preview` : '';
    meta.append(el('code', '', item.providerAssetId), el('span', 'meta', `${item.providerRole}${item.providerStatus ? ` · ${item.providerStatus.replaceAll('_', ' ')}` : ''}${dims ? ` · ${dims}` : ''}${item.durationMs ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ''}`));
    if (item.kind === 'video') {
      const load = el('button', 'btn btn-solid media-load-video', () => t('Load original')) as HTMLButtonElement; load.type = 'button';
      load.disabled = item.providerStatus !== 'finished_successfully'; load.addEventListener('click', () => void loadVideo(item, stage, load, token)); meta.append(load);
    }
    save.disabled = item.providerStatus !== 'finished_successfully';
    save.addEventListener('click', () => void (async () => {
      const owner = sessionId; if (!owner) return; save.disabled = true;
      const reply = await run(window.api.saveNativeMediaToProject(owner, item.messageId, item.providerAssetId));
      if (reply) toast(t('Saved to project: {0}', [reply.relativePath])); save.disabled = item.providerStatus !== 'finished_successfully';
    })());
    reveal.addEventListener('click', () => { const owner = sessionId; if (owner) void run(window.api.openNativeMediaProvider(owner, item.messageId, item.providerAssetId)); });
    detail.append(head, stage, meta);
  }
  function render(): void { renderList(); renderDetail(); }

  async function refresh(): Promise<void> {
    const owner = sessionId, token = ++generation; if (!owner) { items = []; selected = ''; render(); options.onAvailabilityChanged?.(); return; }
    const reply = await run(window.api.listNativeMedia(owner)); if (!reply || token !== generation || owner !== sessionId) return;
    const oldAvailable = available(); items = reply; if (!items.some(item => keyOf(item) === selected)) selected = items[0] ? keyOf(items[0]) : ''; render();
    if (oldAvailable !== available()) options.onAvailabilityChanged?.();
  }
  function sync(next: string | null): void { if (next === sessionId) { void refresh(); return; } sessionId = next; generation++; retirePlayback(); items = []; selected = ''; render(); options.onAvailabilityChanged?.(); if (next) void refresh(); }
  function show(): void { shown = true; pane.hidden = false; void refresh(); }
  function hide(): void { shown = false; generation++; pane.hidden = true; retirePlayback(); }
  function mountAt(parent: HTMLElement): void { if (pane.parentElement !== parent) parent.append(pane); }
  function open(messageId: string, assetId: string): void { selected = `${messageId}\u0000${assetId}`; render(); }

  refreshButton.addEventListener('click', () => void refresh());
  pane.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); options.onEscape?.(); } });
  return { pane, mountAt, show, hide, sync, refresh, open, available, visible: () => shown && !pane.hidden };
}
