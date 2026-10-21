import { providerText } from './provider-text.js';
import { el, icon } from './dom.js';
import { currentLanguage, onLanguageChange, t, ui, type Language } from './i18n.js';
import { quoted } from './extension-pictures.js';
import pages from './setup-images/pages/manifest.json';
import { initToolApprovalNotice } from './tool-approval.js';
import type { ChatProvider } from '../shared/chat-provider.js';

/** One place to click: a few words, and where it is on the picture as percentages of its size. */
type Spot = { text: () => string; box: [number, number, number, number]; pin?: 'top-left' | 'bottom-left' | 'outside-left' };
type Shot = { src: string; spots: Spot[] };
type Box = [number, number, number, number];
type Capture = { file: string; size: [number, number]; labels: Record<string, string>; spots: Record<string, Box> };
/** A page captured by scripts/capture-setup-pages.mjs: its own words fill the move texts. */
type Page = { scene: string; spots: Array<{ key: string; text: (labels: Record<string, string>) => string; pin?: Spot['pin'] }> };
type Still = { src: string; spots: Array<{ text: string | (() => string); box: Box; pin?: Spot['pin'] }> };

const pageFiles = import.meta.glob('./setup-images/pages/*.{webp,svg}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

/** The capture of a page in the app's language (Gemini's own words there), else in English. */
function capture(scene: string, language: Language = currentLanguage()): Capture | null {
  const scenes = pages as unknown as Record<string, Partial<Record<Language, Capture>>>;
  return scenes[scene]?.[language] ?? scenes[scene]?.en ?? null;
}

/** A label Gemini shows in the app's language, else its English one: for steps without a capture of their own. */
function label(scene: string, key: string): string {
  const scenes = pages as unknown as Record<string, Partial<Record<Language, { labels: Record<string, string> }>>>;
  return scenes[scene]?.[currentLanguage()]?.labels[key] ?? scenes[scene]!.en!.labels[key]!;
}

// Only reviewed, redacted captures belong here: placeholders stand in for every name, address and id.
// The Gemini and OpenAI Platform pages are re-captured with scripts/capture-setup-pages.mjs.
const guides: Record<string, Array<Page | Still>> = {
  signin: [
    { src: new URL('./setup-images/cos-browser-sign-in.png', import.meta.url).href, spots: [
      // Two places side by side: the pins take opposite corners so neither covers the other.
      { text: () => t('Click {0}', [quoted(label('signin', 'login'))]), box: [72, 11.7, 8.7, 10.6], pin: 'bottom-left' },
      { text: 'Green dot: the app is connected', box: [77.2, 2.6, 2.9, 5.1] }
    ] }
  ],
  'external-browser': [
    { src: new URL('./setup-images/external-browser-chatgpt.png', import.meta.url).href, spots: [
      { text: 'Review extension', box: [96.1, 2.8, 2.6, 5.1], pin: 'outside-left' },
      { text: () => t('Click {0}', [quoted(label('signin', 'login'))]), box: [91.2, 12.1, 7.5, 11.1], pin: 'bottom-left' }
    ] }
  ],
  tunnel: [
    { scene: 'tunnel-create', spots: [
      { key: 'name', text: () => t('Name it') },
      { key: 'workspace', text: () => providerText('Pick your Gemini workspace') },
      { key: 'create', text: labels => t('Click {0}', [quoted(labels.create!)]) }
    ] },
    { scene: 'tunnel-id', spots: [{ key: 'copy', text: () => t('Copy the tunnel ID') }] }
  ],
  key: [
    { scene: 'api-key-create', spots: [
      { key: 'project', text: () => t('Pick your project') },
      { key: 'restricted', text: labels => t('Choose {0}', [quoted(labels.restricted!)]) }
    ] },
    { scene: 'api-key-tunnels', spots: [
      { key: 'tunnels', text: labels => t('{0}: {1} and {2}', [quoted(labels.tunnels!), quoted(labels.read!), quoted(labels.use!)]) }
    ] }
  ],
  plugin: [
    { src: new URL('./setup-images/gemini-connect.png', import.meta.url).href, spots: [
      { text: 'Open Gemini Connected apps, then Custom', box: [76, 7.8, 11, 5.6] },
      { text: 'Paste this app’s HTTPS MCP server URL', box: [16.5, 41.5, 46, 8.5] },
      { text: 'Choose Next, accept the notice, then Connect', box: [55, 79, 8, 8] }
    ] },
    { src: new URL('./setup-images/gemini-oauth.png', import.meta.url).href, spots: [
      { text: 'Leave Client ID and Client secret empty for this app', box: [22, 15, 64, 39] },
      { text: 'Review the tool list and finish connecting. The companion selects this app and approves its enabled tools automatically.', box: [22, 61, 64, 30] }
    ] }
  ],
  'chatgpt-plugin': [
    { scene: 'plugin-add', spots: [
      { key: 'add', text: labels => t('Click {0}', [quoted(labels.add!)]) },
      { key: 'item', text: labels => t('Choose {0}', [quoted(labels.item!)]) }
    ] },
    { scene: 'plugin-new', spots: [
      { key: 'name', text: () => t('Copy the connector name shown below. The name in this example is illustrative.') },
      { key: 'connection', text: () => t('Choose Server URL and paste the HTTPS MCP server URL from OneCode.') },
      { key: 'auth', text: () => t('Choose No authentication for this secret OneCode URL.') },
      { key: 'create', text: () => t('Review the notice, then choose Create as a plugin.') }
    ] }
  ]
};

/** The pictures and move texts of a guide in the app's current language. */
function shots(group: string): Shot[] {
  return (guides[group] ?? []).flatMap(entry => {
    if ('src' in entry) return [{ src: entry.src, spots: entry.spots.map(spot => ({ ...spot, text: typeof spot.text === 'string' ? () => t(spot.text as string) : spot.text })) }];
    const page = capture(entry.scene);
    const src = page ? pageFiles[`./setup-images/pages/${page.file}`] : undefined;
    if (!page || !src) return [];
    return [{ src, spots: entry.spots.flatMap(spot => page.spots[spot.key]
      ? [{ box: page.spots[spot.key]!, pin: spot.pin, text: () => spot.text(capture(entry.scene)?.labels ?? page.labels) }] : []) }];
  });
}

/** A picture with its click targets marked, numbered from `first` so pins match the moves. */
function picture(shot: Shot, first: number): HTMLElement {
  const frame = el('span', 'guide-picture');
  const img = document.createElement('img');
  img.src = shot.src;
  img.alt = '';
  img.decoding = 'async';
  img.draggable = false;
  frame.append(img);
  shot.spots.forEach((spot, index) => {
    const [x, y, width, height] = spot.box;
    const mark = el('span', 'guide-spot');
    mark.dataset.spot = String(first + index);
    Object.assign(mark.style, { left: `${x}%`, top: `${y}%`, width: `${width}%`, height: `${height}%` });
    const pin = el('span', 'guide-pin', String(first + index + 1));
    if (spot.pin) pin.dataset.corner = spot.pin;
    mark.append(pin);
    frame.append(mark);
  });
  return frame;
}

/**
 * The step's moves beside its pictures. Pointing at a move (or focusing it) shows the picture
 * it happens in and lights its place there; the picture itself opens full size.
 */
function guide(host: HTMLElement, shots: Shot[], enlarge: (shot: Shot, first: number) => void): void {
  const moves = el('ol', 'guide-moves');
  const stage = el('div', 'guide-stage');
  const frames: HTMLButtonElement[] = [];
  const dots = el('div', 'guide-dots');
  const firsts: number[] = [];
  let next = 0;
  for (const shot of shots) { firsts.push(next); next += shot.spots.length; }

  const show = (shotIndex: number, spot: number | null) => {
    frames.forEach((frame, index) => { frame.hidden = index !== shotIndex; });
    for (const mark of stage.querySelectorAll<HTMLElement>('.guide-spot')) {
      mark.classList.toggle('is-lit', spot !== null && Number(mark.dataset.spot) === spot);
    }
    for (const move of moves.querySelectorAll<HTMLElement>('.guide-move')) {
      move.classList.toggle('is-lit', spot !== null && Number(move.dataset.spot) === spot);
      move.classList.toggle('is-here', Number(move.dataset.shot) === shotIndex);
    }
    [...dots.children].forEach((dot, index) => dot.setAttribute('aria-pressed', String(index === shotIndex)));
    stage.classList.toggle('has-lit', spot !== null);
  };

  shots.forEach((shot, shotIndex) => {
    const frame = el('button', 'guide-frame') as HTMLButtonElement;
    frame.type = 'button';
    ui(frame, 'aria-label', () => t('Enlarge image'));
    frame.append(picture(shot, firsts[shotIndex]!), icon('i-zoom-in', 'ico guide-zoom'));
    frame.addEventListener('click', () => enlarge(shot, firsts[shotIndex]!));
    frames.push(frame);
    stage.append(frame);
    shot.spots.forEach((spot, index) => {
      const move = el('li', 'guide-move');
      move.tabIndex = 0;
      move.dataset.shot = String(shotIndex);
      move.dataset.spot = String(firsts[shotIndex]! + index);
      move.append(el('span', 'guide-pin', String(firsts[shotIndex]! + index + 1)), el('span', 'guide-move-text', spot.text));
      const light = () => show(shotIndex, firsts[shotIndex]! + index);
      move.addEventListener('pointerenter', light);
      move.addEventListener('focus', light);
      move.addEventListener('click', light);
      moves.append(move);
    });
    if (shots.length > 1) {
      const dot = el('button', 'guide-dot') as HTMLButtonElement;
      dot.type = 'button';
      ui(dot, 'aria-label', () => t('Picture {0} of {1}', [shotIndex + 1, shots.length]));
      dot.addEventListener('click', () => show(shotIndex, null));
      dots.append(dot);
    }
  });
  moves.addEventListener('pointerleave', () => show(frames.findIndex(frame => !frame.hidden), null));
  if (shots.length > 1) stage.append(dots);
  show(0, null);
  // A step may keep its moves in its own column, apart from the pictures beside them.
  const slot = host.dataset.movesInto ? document.getElementById(host.dataset.movesInto) : null;
  if (slot) { slot.append(moves); host.append(stage); } else host.append(moves, stage);
}

/** Pictures sit small beside their moves; each opens full size, pins and all, in one dialog. */
export function initSetupGuide(): (provider: ChatProvider) => void {
  let provider: ChatProvider = 'gemini';
  initToolApprovalNotice(window.api?.onToolApprovalNotice);
  const dialog = document.createElement('dialog');
  dialog.className = 'setup-image-dialog';
  ui(dialog, 'aria-label', () => t('Setup screenshot'));
  const close = el('button', 'btn', () => t('Close'));
  close.setAttribute('type', 'button');
  close.addEventListener('click', () => dialog.close());
  const large = el('div', 'guide-large');
  dialog.append(close, large);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => large.replaceChildren());
  document.body.append(dialog);

  const enlarge = (shot: Shot, first: number) => {
    const legend = el('ol', 'guide-moves');
    shot.spots.forEach((spot, index) => {
      const move = el('li', 'guide-move');
      move.append(el('span', 'guide-pin', String(first + index + 1)), el('span', 'guide-move-text', spot.text));
      legend.append(move);
    });
    large.replaceChildren(picture(shot, first), legend);
    dialog.showModal();
  };
  // Captured pages change with the language (Gemini's own words and screens), so the guides are
  // built again on a language change, the moves a step keeps in its own column included.
  const build = (): void => {
    for (const host of document.querySelectorAll<HTMLElement>('[data-setup-guide]')) {
      host.replaceChildren();
      const slot = host.dataset.movesInto ? document.getElementById(host.dataset.movesInto) : null;
      slot?.querySelector(':scope > .guide-moves')?.remove();
      const group = host.dataset.setupGuide === 'plugin' && provider === 'chatgpt' ? 'chatgpt-plugin' : host.dataset.setupGuide!;
      const pictures = shots(group);
      if (pictures.length) guide(host, pictures, enlarge);
    }
  };
  build();
  onLanguageChange(build);
  return next => { if (provider !== next) { provider = next; if (dialog.open) dialog.close(); build(); } };
}
