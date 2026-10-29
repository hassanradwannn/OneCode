import { marked } from 'marked';
import type { ArtifactFile, ArtifactKind, ArtifactOrigin } from '../shared/artifact.js';
import { nativeWidgetStyle } from './native-widget-preview.js';
import { sanitizeHtmlTree } from './sanitize-html.js';
import { ARTIFACT_VIEWPORTS, fitArtifactViewport, type ArtifactViewport } from './artifact-viewport.js';

const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; base-uri 'none'; form-action 'none'";
const MARKDOWN_TAGS = new Set(['P', 'BR', 'HR', 'STRONG', 'EM', 'S', 'DEL', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'KBD',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A']);
const MARKDOWN_DROPS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'META', 'LINK']);

export interface ArtifactPreviewMessage { level: 'log' | 'info' | 'warn' | 'error'; text: string }
export interface ArtifactPreviewHandle { setViewport(mode: ArtifactViewport): void; destroy(): void }

function htmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function resolveArtifactReference(fromPath: string, reference: string): string | null {
  const raw = reference.trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return null;
  const clean = raw.split(/[?#]/, 1)[0]!;
  const parts = fromPath.split('/').slice(0, -1);
  for (const part of clean.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

function previewStorageScript(): string {
  // Opaque-origin sandboxes can throw even when merely reading localStorage.
  // A document-local fallback keeps ordinary demos working without granting an
  // origin, filesystem, persistence, network or access to the host's storage.
  return `(function(){for(const name of ['localStorage','sessionStorage']){try{void window[name].length;continue}catch{}const data=new Map();let bytes=0;const storage={get length(){return data.size},key(i){return [...data.keys()][Number(i)]??null},getItem(k){return data.get(String(k))??null},setItem(k,v){k=String(k);v=String(v);const next=bytes-(data.has(k)?k.length+data.get(k).length:0)+k.length+v.length;if(k.length>4096||next>262144||(!data.has(k)&&data.size>=2048))throw new DOMException('Preview storage quota exceeded','QuotaExceededError');data.set(k,v);bytes=next},removeItem(k){k=String(k);bytes-=data.has(k)?k.length+data.get(k).length:0;data.delete(k)},clear(){data.clear();bytes=0}};Object.defineProperty(window,name,{value:storage,configurable:false})}})();`;
}

function consoleBridgeScript(channel: string): string {
  const key = JSON.stringify(channel);
  return `(function(){const key=${key};let sent=0;const emit=(level,args)=>{if(sent++>100)return;let text='';try{text=args.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' ').slice(0,4000)}catch{text='[unserializable]'};parent.postMessage({__onecodeArtifactPreview:key,level,text},'*')};for(const level of ['log','info','warn','error']){const original=console[level]?.bind(console);console[level]=(...args)=>{emit(level,args);original?.(...args)}};addEventListener('error',e=>emit('error',[e.message||'Preview error']));addEventListener('unhandledrejection',e=>emit('error',[String(e.reason||'Unhandled rejection')]))})();`;
}

function previewShell(body: string, head: string, channel: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">${head}<script>${consoleBridgeScript(channel).replace(/<\/script/gi, '<\\/script')}</script></head><body>${body}</body></html>`;
}

function markdownDocument(file: ArtifactFile, channel: string): string {
  const parsed = new DOMParser().parseFromString(String(marked.parse(file.text, { async: false })), 'text/html');
  sanitizeHtmlTree(parsed.body, { allowedTags: MARKDOWN_TAGS, dropTags: MARKDOWN_DROPS, safeHref: value => value.startsWith('#') ? value : null, preserveDirection: true });
  const style = '<style>html{font:14px/1.6 system-ui,sans-serif;color:#202124;background:#fff}body{max-width:900px;margin:0 auto;padding:24px}pre{overflow:auto;padding:12px;background:#f5f6f7;border-radius:8px}code{font-family:ui-monospace,monospace}table{border-collapse:collapse}td,th{border:1px solid #ccd0d5;padding:5px 8px}blockquote{border-left:3px solid #ccd0d5;padding-left:12px;color:#5f6368}</style>';
  return previewShell(parsed.body.innerHTML, style, channel);
}

function svgDocument(file: ArtifactFile, channel: string): string {
  const data = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.text)}`;
  return previewShell(`<img alt="SVG preview" src="${htmlEscape(data)}" style="display:block;max-width:100%;max-height:100vh;margin:auto">`,
    '<style>html,body{margin:0;min-height:100%;background:#fff}body{display:grid;place-items:center}</style>', channel);
}

function webDocument(files: ArtifactFile[], entrypoint: string, channel: string, widget = false, dark = false): string {
  const byPath = new Map(files.map(file => [file.path, file]));
  const entry = byPath.get(entrypoint) ?? files.find(file => /\.html?$/i.test(file.path)) ?? files[0]!;
  if (!/\.html?$/i.test(entry.path) && !/html/i.test(entry.mimeType ?? '')) {
    return previewShell(`<pre>${htmlEscape(entry.text)}</pre>`, '<style>pre{white-space:pre-wrap;font:13px/1.5 ui-monospace,monospace}</style>', channel);
  }
  const parsed = new DOMParser().parseFromString(entry.text, 'text/html');
  for (const node of [...parsed.querySelectorAll('base,iframe,object,embed,meta[http-equiv=refresh]')]) node.remove();
  for (const link of [...parsed.querySelectorAll<HTMLLinkElement>('link[rel~=stylesheet][href]')]) {
    const resolved = resolveArtifactReference(entry.path, link.getAttribute('href') ?? '');
    const source = resolved ? byPath.get(resolved) : null;
    if (!source) { link.remove(); continue; }
    const style = parsed.createElement('style'); style.textContent = source.text; link.replaceWith(style);
  }
  for (const script of [...parsed.querySelectorAll<HTMLScriptElement>('script[src]')]) {
    const resolved = resolveArtifactReference(entry.path, script.getAttribute('src') ?? '');
    const source = resolved ? byPath.get(resolved) : null;
    if (!source) { script.remove(); continue; }
    script.removeAttribute('src'); script.textContent = source.text.replace(/<\/script/gi, '<\\/script');
  }
  for (const image of [...parsed.querySelectorAll<HTMLImageElement>('img[src]')]) {
    const value = image.getAttribute('src') ?? '';
    if (value.startsWith('data:')) continue;
    const resolved = resolveArtifactReference(entry.path, value);
    const source = resolved ? byPath.get(resolved) : null;
    if (source && /\.svg$/i.test(source.path)) image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source.text)}`;
    else image.removeAttribute('src');
  }
  for (const anchor of [...parsed.querySelectorAll<HTMLAnchorElement>('a[href]')]) {
    const href = anchor.getAttribute('href') ?? ''; if (!href.startsWith('#')) anchor.removeAttribute('href');
  }
  for (const form of [...parsed.querySelectorAll<HTMLFormElement>('form')]) form.removeAttribute('action');
  const csp = parsed.createElement('meta'); csp.httpEquiv = 'Content-Security-Policy'; csp.content = PREVIEW_CSP;
  const charset = parsed.createElement('meta'); charset.setAttribute('charset', 'utf-8');
  const viewport = parsed.createElement('meta'); viewport.name = 'viewport'; viewport.content = 'width=device-width,initial-scale=1';
  for (const existing of [...parsed.querySelectorAll('meta[name="viewport"]')]) existing.remove();
  const scrolling = parsed.createElement('style'); scrolling.textContent = `
    *{overscroll-behavior:contain}
    ::-webkit-scrollbar{width:10px;height:10px;background:transparent}
    ::-webkit-scrollbar-thumb{border:3px solid transparent;border-radius:999px;background:#8888;background-clip:padding-box}
    @supports not selector(::-webkit-scrollbar){*{scrollbar-width:thin;scrollbar-color:#8888 transparent}}
  `;
  const bridge = parsed.createElement('script'); bridge.textContent = (previewStorageScript() + consoleBridgeScript(channel)).replace(/<\/script/gi, '<\\/script');
  parsed.head.prepend(charset, csp, viewport, bridge); parsed.head.append(scrolling);
  if (widget) {
    const style = new DOMParser().parseFromString(nativeWidgetStyle(dark), 'text/html').querySelector('style');
    if (style) parsed.head.insertBefore(parsed.importNode(style, true), bridge);
  }
  return `<!doctype html>${parsed.documentElement.outerHTML}`;
}

export async function artifactPreviewDocument(files: ArtifactFile[], entrypoint: string | undefined, kind: ArtifactKind, channel: string, origin?: ArtifactOrigin, dark = document.documentElement.dataset.theme === 'dark'): Promise<string> {
  if (!files.length) return previewShell('<p>Artifact has no files.</p>', '', channel);
  const entry = files.find(file => file.path === entrypoint) ?? files[0]!;
  if (kind === 'markdown' || /\.(?:md|markdown)$/i.test(entry.path)) return markdownDocument(entry, channel);
  if (/\.svg$/i.test(entry.path) || /svg/i.test(entry.mimeType ?? '')) return svgDocument(entry, channel);
  if (kind === 'diagram' && (/\.(?:mmd|mermaid)$/i.test(entry.path) || /mermaid/i.test(entry.language ?? '') || /mermaid/i.test(entry.mimeType ?? ''))) {
    if (entry.text.length > 50000) return previewShell('<p role="alert">Diagram source exceeds the 50,000 character preview limit. The original source remains available in the editor.</p>', '', channel);
    const { diagramBody, diagramStyle } = await import('./artifact-mermaid-preview.js');
    return previewShell(diagramBody(entry.text), diagramStyle, channel);
  }
  if (kind === 'web' && /\.(?:jsx|tsx|[cm]?js|ts)$/i.test(entry.path)) {
    const { reactPreview } = await import('./artifact-react-preview.js');
    const preview = await reactPreview(files, entry.path);
    const result = previewShell(preview.body, preview.head + `<script>${previewStorageScript()}</script>`, channel);
    if (new TextEncoder().encode(result).length > 4 * 1024 * 1024)
      return previewShell('<p role="alert">Component preview exceeds its size limit. The original files remain available in the editor.</p>', '', channel);
    return result;
  }
  if (kind === 'web') return webDocument(files, entry.path, channel,
    origin?.provider === 'claude' && /^widget:toolu_[A-Za-z0-9]{20,100}$/.test(origin.nativeSurface ?? ''), dark);
  return previewShell(`<pre>${htmlEscape(entry.text)}</pre>`, '<style>pre{white-space:pre-wrap;font:13px/1.5 ui-monospace,monospace}</style>', channel);
}

export function createArtifactPreview(options: {
  parent: HTMLElement; files: ArtifactFile[]; entrypoint?: string; kind: ArtifactKind; origin?: ArtifactOrigin; onMessage?: (message: ArtifactPreviewMessage) => void;
  controls?: HTMLElement;
  createDocument?: (document: string) => Promise<{ id: string; url: string } | null>;
  releaseDocument?: (id: string) => void;
}): ArtifactPreviewHandle {
  const channel = crypto.randomUUID();
  const frame = document.createElement('iframe');
  frame.className = 'artifact-preview-frame';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.title = 'Artifact preview';
  let retired = false, documentId: string | null = null;
  void artifactPreviewDocument(options.files, options.entrypoint, options.kind, channel, options.origin,
    options.parent.ownerDocument.defaultView?.getComputedStyle(options.parent).colorScheme === 'dark').then(async documentSource => {
    if (retired) return;
    if (!options.createDocument) { frame.srcdoc = documentSource; return; }
    const value = await options.createDocument(documentSource);
    if (!value) throw new Error('Preview document unavailable');
    if (retired) { options.releaseDocument?.(value.id); return; }
    documentId = value.id; frame.src = value.url;
  }).catch(() => {
    if (retired) return;
    const message = document.createElement('p'); message.textContent = 'Preview unavailable. Reopen the artifact to try again.';
    message.setAttribute('role', 'status'); shell.replaceChildren(message);
  });
  const shell = document.createElement('div'); shell.className = 'artifact-preview-shell'; shell.append(frame); options.parent.replaceChildren(shell);
  let viewport: ArtifactViewport = 'responsive';
  const simulated = options.kind === 'web';
  const selector = document.createElement('select'); selector.className = 'artifact-viewport-select'; selector.setAttribute('aria-label', 'Preview viewport');
  for (const [value, preset] of Object.entries(ARTIFACT_VIEWPORTS)) {
    const option = document.createElement('option'); option.value = value; option.textContent = preset.label; selector.append(option);
  }
  selector.value = viewport;
  const resize = () => {
    if (!simulated || retired) return;
    const fit = fitArtifactViewport(viewport, shell.clientWidth, shell.clientHeight);
    frame.style.width = `${fit.width}px`; frame.style.height = `${fit.height}px`;
    frame.style.left = `${fit.left}px`; frame.style.top = `${fit.top}px`;
    frame.style.transform = `scale(${fit.scale})`; frame.style.transformOrigin = '0 0';
  };
  const setViewport = (mode: ArtifactViewport) => {
    viewport = mode; selector.value = mode; selector.title = mode === 'responsive' ? 'Use the available preview size' : `${ARTIFACT_VIEWPORTS[mode].width} × ${ARTIFACT_VIEWPORTS[mode].height} · Fit to preview`;
    options.parent.dataset.previewViewport = mode; resize();
  };
  const observer = simulated ? new ResizeObserver(resize) : null;
  if (simulated) {
    shell.classList.add('is-browser-viewport');
    setViewport(viewport); observer!.observe(shell);
    selector.onchange = () => setViewport(selector.value === 'portrait' ? 'portrait' : selector.value === 'landscape' ? 'landscape' : 'responsive');
    (options.controls ?? shell).append(selector);
  }
  let messages = 0;
  const receive = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow || messages >= 100) return;
    const data = event.data as { __onecodeArtifactPreview?: unknown; level?: unknown; text?: unknown } | null;
    if (!data || data.__onecodeArtifactPreview !== channel || !['log', 'info', 'warn', 'error'].includes(String(data.level)) || typeof data.text !== 'string') return;
    messages++; options.onMessage?.({ level: data.level as ArtifactPreviewMessage['level'], text: data.text.slice(0, 4000) });
  };
  window.addEventListener('message', receive);
  return { setViewport, destroy(): void { retired = true; observer?.disconnect(); selector.remove(); delete options.parent.dataset.previewViewport; window.removeEventListener('message', receive); if (documentId) options.releaseDocument?.(documentId); frame.remove(); shell.remove(); } };
}
