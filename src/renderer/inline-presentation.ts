import type { ArtifactPresentation } from '../shared/artifact.js';
import { createArtifactPreview } from './artifact-preview.js';
import { el, icon, run } from './dom.js';
import { t } from './i18n.js';

const live = new Map<HTMLElement, () => void>();
const fullscreenOrigins = new Map<HTMLElement, Node>();
export function retireDetachedPresentations(): void {
  for (const [node, destroy] of live) if (!node.isConnected || fullscreenOrigins.has(node) && !fullscreenOrigins.get(node)!.isConnected) { destroy(); live.delete(node); }
}
export function generationPlaceholder(label = t('Generating')): HTMLElement {
  const stage = el('div', 'generation-placeholder'); stage.title = label; stage.setAttribute('aria-label', label); stage.setAttribute('role', 'status'); stage.setAttribute('aria-busy', 'true');
  const text = el('span', 'sr-only', label); stage.append(text); return stage;
}
export async function loadInlineVideo(frame: HTMLElement, button: HTMLButtonElement, sessionId: string,
                                      messageId: string, assetId: string, current: () => boolean, presentationId?: string): Promise<void> {
  button.disabled = true;
  let retired = false, objectUrl = '', token = '';
  const valid = () => !retired && current() && frame.isConnected;
  live.set(frame, () => { retired = true; if (objectUrl) URL.revokeObjectURL(objectUrl); });
  try {
    const reply = presentationId ? await window.api.preparePresentedVideoPlayback(sessionId, presentationId)
      : await window.api.prepareNativeVideoPlayback(sessionId, messageId, assetId);
    if (!reply.ok) throw new Error(reply.error);
    const playback = reply.data; token = playback.token;
    const parts: ArrayBuffer[] = []; let offset = 0;
    while (offset < playback.bytes && valid()) {
      const reply = await window.api.readNativeVideoPlaybackChunk(sessionId, token, offset, 1024 * 1024);
      if (!reply.ok) throw new Error(reply.error); const chunk = reply.data;
      if (chunk.totalBytes !== playback.bytes || chunk.offset !== offset || chunk.nextOffset <= offset || chunk.nextOffset > playback.bytes) throw new Error('Invalid video transfer');
      const decoded = atob(chunk.data), data = new Uint8Array(new ArrayBuffer(decoded.length));
      for (let i = 0; i < decoded.length; i++) data[i] = decoded.charCodeAt(i);
      if (data.byteLength !== chunk.nextOffset - offset) throw new Error('Incomplete video transfer');
      parts.push(data.buffer); offset = chunk.nextOffset;
    }
    if (!valid()) return;
    if (offset !== playback.bytes) throw new Error('Incomplete video transfer');
    objectUrl = URL.createObjectURL(new Blob(parts, { type: playback.mimeType }));
    const video = document.createElement('video'); video.src = objectUrl; video.controls = true; video.preload = 'metadata'; video.setAttribute('aria-label', t('Generated video')); frame.replaceChildren(video);
    void video.play().catch(() => undefined);
  } catch (error) { if (valid()) frame.replaceChildren(el('p', 'meta', (error as Error).message)); }
  finally { if (token) void window.api.releaseNativeVideoPlayback(sessionId, token); button.disabled = false; }
}
export function inlinePresentation(value: ArtifactPresentation, sessionId: string, current: () => boolean,
                                   open: (artifactId: string, revision?: number) => void, active = true): HTMLElement {
  const row = el('section', 'inline-presentation'); row.dataset.presentationId = value.id;
  if (value.status === 'generating') {
    const stage = generationPlaceholder(active ? t('Generating') : t('Generation interrupted'));
    if (!active) { stage.classList.add('is-interrupted'); stage.setAttribute('aria-busy', 'false'); }
    row.append(stage); return row;
  }
  if (value.status === 'failed') { row.append(el('p', 'meta', () => t('Generation failed'))); return row; }
  const stage = el('div', value.asset ? 'inline-presentation-image' : 'inline-presentation-preview');
  stage.append(generationPlaceholder(t('Loading preview'))); row.append(stage);
  let retired = false;
  let fullscreen: HTMLDialogElement | null = null;
  const closeFullscreen = () => { if (fullscreen?.open) fullscreen.close(); };
  const valid = () => !retired && current() && row.isConnected;
  live.set(row, () => { retired = true; closeFullscreen(); });
  if (value.kind === 'video' && value.asset) {
    const title = el('strong', '', value.title);
    const play = el('button', 'btn', () => t('Play video')) as HTMLButtonElement; play.type = 'button';
    play.onclick = () => { void loadInlineVideo(stage, play, sessionId, '', '', valid, value.id); };
    stage.replaceChildren(title, play);
  } else if (value.asset) {
    void run(window.api.getSessionImage(sessionId, value.asset.id)).then(data => {
      if (!valid()) return;
      if (!data) { stage.replaceChildren(el('p', 'meta', () => t('Image preview unavailable'))); return; }
      const image = document.createElement('img'); image.src = data; image.alt = value.title; stage.replaceChildren(image);
    });
  } else if (value.artifactId) {
    const artifactId = value.artifactId;
    const toolbar = el('header', 'inline-presentation-toolbar'); toolbar.append(el('strong', '', value.title));
    const actions = el('div', 'inline-presentation-actions');
    const workbench = el('button', 'btn btn-icon') as HTMLButtonElement; workbench.type = 'button'; workbench.title = t('Open in workbench'); workbench.setAttribute('aria-label', workbench.title); workbench.append(icon('i-panel-right'));
    workbench.onclick = () => { if (current()) { closeFullscreen(); open(artifactId, value.revision); } };
    const expand = el('button', 'btn btn-icon') as HTMLButtonElement; expand.type = 'button'; expand.title = t('Expand preview'); expand.setAttribute('aria-label', expand.title); expand.setAttribute('aria-expanded', 'false'); expand.append(icon('i-dock-expand'));
    expand.onclick = () => {
      if (!current()) return;
      if (fullscreen?.open) { closeFullscreen(); return; }
      const origin = document.createComment('inline presentation'); row.before(origin); fullscreenOrigins.set(row, origin);
      const dialog = document.createElement('dialog'); dialog.className = 'artifact-fullscreen'; dialog.setAttribute('aria-label', value.title);
      document.body.append(dialog);
      if (typeof dialog.moveBefore === 'function') dialog.moveBefore(row, null); else dialog.append(row);
      fullscreen = dialog;
      dialog.addEventListener('close', () => {
        if (origin.parentElement && typeof origin.parentElement.moveBefore === 'function') { origin.parentElement.moveBefore(row, origin); origin.remove(); }
        else if (origin.isConnected) origin.replaceWith(row); else row.remove();
        fullscreenOrigins.delete(row); fullscreen = null; dialog.remove();
        expand.title = t('Expand preview'); expand.setAttribute('aria-label', expand.title); expand.setAttribute('aria-expanded', 'false'); expand.replaceChildren(icon('i-dock-expand'));
        if (expand.isConnected) expand.focus();
      }, { once: true });
      expand.title = t('Restore preview'); expand.setAttribute('aria-label', expand.title); expand.setAttribute('aria-expanded', 'true'); expand.replaceChildren(icon('i-dock-restore'));
      dialog.showModal();
    }; actions.append(workbench, expand); toolbar.append(actions); row.prepend(toolbar);
    void run(window.api.readArtifact(sessionId, artifactId, value.revision)).then(snapshot => {
      if (!valid()) return;
      if (!snapshot || snapshot.artifact.id !== artifactId) { stage.replaceChildren(el('p', 'meta', () => t('Artifact preview unavailable'))); return; }
      const handle = createArtifactPreview({ parent: stage, controls: actions, files: snapshot.revision.files, entrypoint: snapshot.artifact.entrypoint, kind: snapshot.artifact.kind, origin: snapshot.artifact.origin,
        createDocument: document => run(window.api.createArtifactPreviewDocument(sessionId, artifactId, snapshot.revision.revision, document)),
        releaseDocument: id => { void window.api.releaseArtifactPreviewDocument(sessionId, id); } });
      live.set(row, () => { retired = true; closeFullscreen(); handle.destroy(); });
    });
  } else stage.replaceChildren(el('p', 'meta', () => t('Preview unavailable')));
  return row;
}
