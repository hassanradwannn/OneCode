import { useEffect, useRef, useState } from 'react';
import { Marked } from 'marked';
import type { ControlApiEvent } from '../shared/control-api.js';
import type { AgentPlan } from '../shared/agent-plan.js';
import { chronological } from '../shared/chronology.js';
import { usageLimitResetText, usageLimitTitle } from '../shared/provider-usage-limit.js';
import { hasProviderDirective, withoutProviderDirectives } from '../shared/content-reference.js';
import { formatMessageContent, MESSAGE_TAGS, MESSAGE_DROP_TAGS, MAX_MESSAGE_MARKUP } from '../renderer/message-format.js';
import { sanitizeHtmlTree } from '../renderer/sanitize-html.js';
import { nativeMessageMarkup, stageNativeMessageContent } from '../renderer/native-message-content.js';
import { chatProviderForStoredConversation, chatProviderConversationUrl, isBrowserChatProvider, isChatProviderConversationId } from '../shared/chat-provider.js';
import { drawMath, mathExtensions, separateDisplayMath, type MathSlots } from '../renderer/math.js';
import { renderAgentPlan } from '../renderer/agent-plan.js';
import { RichPresentation } from './presentation.js';
import { Icon } from './composer-controls.js';
import { authoredUrlSegments, safeExternalLink, safeProviderFileLink } from '../shared/external-link.js';
import { MAX_INPUT_IMAGES } from '../shared/input.js';
import { request } from './api.js';

async function copyText(value: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(value); return true; } catch { return false; }
}
export function AuthoredText({ text }: { text: string }) {
  return <>{authoredUrlSegments(text).map((segment, index) => segment.href
    ? <a key={index} href={segment.href} target="_blank" rel="noopener noreferrer">{segment.text}</a>
    : segment.text)}</>;
}
function UserImage({ sessionId, assetId, index, onOpen }: { sessionId: string; assetId: string; index: number; onOpen: (src: string) => void }) {
  const [src, setSrc] = useState<string | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setSrc(null); setFailed(false);
    void request<string | null>(`sessions/${sessionId}/images/${encodeURIComponent(assetId)}`)
      .then(value => { if (alive) { if (value) setSrc(value); else setFailed(true); } })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [sessionId, assetId]);
  if (failed) return <span className="user-image-unavailable" role="status">Image unavailable</span>;
  if (!src) return <span className="user-image-loading" role="status">Image preview is loading</span>;
  return <button type="button" className="user-image-thumb" aria-label={`Preview image ${index + 1}`} onClick={() => onOpen(src)}><img src={src} alt="User attachment" /></button>;
}
function UserImages({ sessionId, event }: { sessionId: string; event: ControlApiEvent }) {
  const [preview, setPreview] = useState<{ src: string; index: number } | null>(null);
  const assets = (event.assets ?? []).slice(0, MAX_INPUT_IMAGES);
  useEffect(() => { setPreview(null); }, [sessionId]);
  useEffect(() => {
    if (!preview) return;
    const close = (keyEvent: KeyboardEvent) => { if (keyEvent.key === 'Escape') setPreview(null); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [preview]);
  if (!assets.length && !(event.images && event.images > 0)) return null;
  if (!assets.length) return <div className="user-images"><span className="user-image-unavailable" role="status">Image unavailable</span></div>;
  return <div className="user-images">{assets.map((asset, index) => <UserImage key={asset.id} sessionId={sessionId} assetId={asset.id} index={index} onOpen={src => setPreview({ src, index })} />)}{preview && <div className="attachment-preview-backdrop" role="presentation" onClick={() => setPreview(null)}><section className="attachment-preview" role="dialog" aria-modal="true" aria-label={`Preview image ${preview.index + 1}`} onClick={event => event.stopPropagation()}><header><strong>{`Image ${preview.index + 1}`}</strong><button type="button" aria-label="Close image preview" onClick={() => setPreview(null)} autoFocus>×</button></header><img src={preview.src} alt="User attachment" /></section></div>}</div>;
}
export function Markdown({ text, sessionId, messageId, nativeMarkup, originalUrl }: { text: string; sessionId?: string | null;
  messageId?: string; nativeMarkup?: ControlApiEvent['nativeMarkup']; originalUrl?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = host.current; if (!box) return;
    const abort = new AbortController();
    const source = text.slice(0, MAX_MESSAGE_MARKUP), math: MathSlots = { formulas: [] };
    const parser = new Marked({ gfm: true, extensions: [...mathExtensions(math), {
      name: 'providerInlineReference', level: 'inline',
      start: value => { const at = value.search(/:{1,2}chatgpt-content-reference\{/); return at < 0 ? undefined : at; },
      tokenizer(value) { const found = /^:{1,2}chatgpt-content-reference\{[^}\n]*\}/.exec(value);
        return found ? { type: 'providerInlineReference', raw: found[0] } : undefined; },
      renderer: () => ''
    }] });
    const template = document.createElement('template');
    const native = nativeMessageMarkup(nativeMarkup?.capture, nativeMarkup?.messageId);
    template.innerHTML = native ?? parser.parse(separateDisplayMath(source), { async: false });
    const mountNative = stageNativeMessageContent(template.content, {
      key: JSON.stringify([sessionId, messageId]),
      copy: copyText,
      ...(sessionId && messageId ? { loadImage: async (url: string) =>
        (await request<{ image: string | null }>('reply-image', { sessionId, messageId, url }, abort.signal)).image } : {}),
      ...(originalUrl ? { openOriginal: () => { window.open(originalUrl, '_blank', 'noopener,noreferrer'); } } : {})
    }, native !== null);
    const languages = new WeakMap<Element, string>();
    for (const code of template.content.querySelectorAll('pre > code')) {
      const language = code.className.match(/(?:^|\s)language-([a-z0-9_+#.-]{1,24})(?=\s|$)/i)?.[1];
      if (language) languages.set(code, language.toLowerCase());
    }
    sanitizeHtmlTree(template.content, { allowedTags: MESSAGE_TAGS, dropTags: MESSAGE_DROP_TAGS, preserveDirection: true,
      safeHref: value => { const href = value.trim(); return href.startsWith('#') || safeExternalLink(href) || safeProviderFileLink(href) ? href : null; } });
    mountNative();
    box.replaceChildren(template.content);
    if (!box.textContent?.trim() && source && native === null) box.textContent = source;
    formatMessageContent(box, { languages, copy: copyText }); drawMath(box, math);
    let disposed = false;
    for (const link of box.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const href = link.getAttribute('href')!;
      if (safeExternalLink(href)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; continue; }
      if (!safeProviderFileLink(href)) continue;
      // A private sandbox address cannot be navigated by Safari. Resolve only a
      // recorded assistant link and open its actual provider chat on this device.
      link.removeAttribute('href'); link.setAttribute('role', 'link'); link.tabIndex = 0;
      link.title = 'Open this file in its ChatGPT chat';
      const notice = document.createElement('span'); notice.className = 'provider-file-notice'; notice.setAttribute('role', 'status'); link.after(notice);
      notice.textContent = 'Opens in ChatGPT';
      const open = async () => {
        if (!sessionId || !messageId || disposed || link.getAttribute('aria-busy') === 'true') return;
        const popup = window.open('', '_blank'); if (popup) popup.opener = null;
        link.setAttribute('aria-busy', 'true'); notice.textContent = 'Opening the file’s ChatGPT chat…';
        try {
          const result = await request<{ url: string }>('file-links/resolve', { sessionId, messageId, href }, abort.signal);
          if (disposed) { popup?.close(); return; }
          if (!safeExternalLink(result.url) || new URL(result.url).hostname !== 'chatgpt.com') throw new Error('Provider file destination is unavailable.');
          if (popup) { popup.location.href = result.url; notice.textContent = 'Continue in ChatGPT to download this file.'; }
          else { link.href = result.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; notice.textContent = 'Tap again to open the file’s ChatGPT chat.'; }
        } catch (error) { popup?.close(); if (!disposed) notice.textContent = error instanceof Error ? error.message : 'Could not open this file.'; }
        finally { if (!disposed) link.removeAttribute('aria-busy'); }
      };
      link.addEventListener('click', event => { if (link.hasAttribute('href')) return; event.preventDefault(); void open(); });
      link.addEventListener('keydown', event => { if (event.key === 'Enter' && !link.hasAttribute('href')) { event.preventDefault(); void open(); } });
      if (!sessionId || !messageId) { link.setAttribute('aria-disabled', 'true'); notice.textContent = 'This file’s recorded source is unavailable.'; }
    }
    return () => { disposed = true; abort.abort(); };
  }, [text, sessionId, messageId, nativeMarkup, originalUrl]);
  return <div ref={host} className="msg rich" dir="auto" />;
}
export function CurrentPlan({ sessionId, plan }: { sessionId: string | null; plan?: AgentPlan | null }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => { if (host.current) renderAgentPlan(host.current, sessionId, plan ?? null); }, [sessionId, plan]);
  return <div className="agent-plan" ref={host} hidden aria-label="Current task plan" />;
}
function AnswerActions({ text }: { text: string }) {
  return <div className="answer-actions"><button type="button" title="Copy answer" aria-label="Copy answer" onClick={event => {
    const button = event.currentTarget; void copyText(text).then(ok => { button.title = ok ? 'Copied' : 'Could not copy text'; });
  }}><Icon name="copy" /></button><button type="button" title="Save answer as Markdown" aria-label="Save answer as Markdown" onClick={() => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'onecode-answer.md'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }}><Icon name="download" /></button></div>;
}
function ToolGroup({ events }: { events: ControlApiEvent[] }) {
  const failed = events.some(event => event.tool?.outcome === 'error' || event.tool?.outcome === 'rejected');
  return <details className={`tool-group${failed ? ' is-error' : ''}`}><summary><Icon name={failed ? 'warning' : 'check-circle'} />
    <span>{events.length === 1 ? events[0]!.tool?.summary.title ?? 'Ran tool' : events.at(-1)!.tool?.summary.title ?? 'Ran tools'}</span>
    {events.length > 1 && <span className="tool-count">{events.length}</span>}<Icon name="chevron" /></summary>
    <div className="tool-group-body">{events.map(event => <details className="tool" key={event.tool?.callId ?? event.position}>
      <summary><span>{event.tool?.summary.title ?? event.tool?.name}</span><small>{event.tool?.durationMs ? `${(event.tool.durationMs / 1000).toFixed(1)}s` : ''}</small></summary>
      {event.tool?.args.text && <div className="tool-output"><strong>Arguments</strong><pre>{event.tool.args.text}</pre></div>}
      <div className="tool-output"><strong>Result</strong><pre>{event.tool?.result.text ?? event.detail ?? ''}</pre></div>
    </details>)}</div>
  </details>;
}
export function Transcript({ events, sessionId, conversationId, openRequestId }: { events: ControlApiEvent[]; sessionId: string;
  conversationId?: string | null; openRequestId: string | null }) {
  const provider = chatProviderForStoredConversation(conversationId);
  const originalUrl = provider && isBrowserChatProvider(provider) && isChatProviderConversationId(conversationId, provider)
    ? chatProviderConversationUrl(provider, conversationId) : undefined;
  const ordered = chronological(events.map(event => ({ ...event, origin: event.position })));
  const rows: Array<ControlApiEvent | ControlApiEvent[]> = [];
  for (const event of ordered) {
    if (!event.presentation && !['user_message', 'assistant_message', 'tool_call', 'chat_error', 'native_image', 'native_video', 'progress', 'page_tool'].includes(event.kind)) continue;
    const previous = rows.at(-1);
    if (event.kind === 'tool_call' && !event.presentation) {
      if (Array.isArray(previous) && previous[0]?.turnId === event.turnId) previous.push(event); else rows.push([event]);
    } else rows.push(event);
  }
  return <>{rows.map(row => {
    if (Array.isArray(row)) return <ToolGroup key={`tools:${row[0]!.position}`} events={row} />;
    const rawText = row.message?.text ?? row.detail ?? '';
    const text = row.kind === 'assistant_message' && hasProviderDirective(rawText) ? withoutProviderDirectives(rawText) : rawText;
    if (row.kind === 'assistant_message' && !text.trim() && !row.nativeMarkup) return null;
    if (!row.presentation && ['progress', 'page_tool'].includes(row.kind)) return <div className="activity-row" key={row.position}><Icon name="check-circle" /><span>{text || row.label || 'Working'}</span></div>;
    return <article key={row.position} className={row.kind === 'user_message' ? 'human' : row.kind === 'chat_error' ? 'chat-error' : 'message'}>
      {row.presentation || row.kind === 'native_image' || row.kind === 'native_video'
        ? <RichPresentation event={row} sessionId={sessionId} openRequestId={openRequestId} ended={!!row.turnId && events.some(event => event.kind === 'turn_end' && event.turnId === row.turnId)} />
        : row.kind === 'user_message' ? <><UserImages sessionId={sessionId} event={row} /><div className="msg" dir="auto"><AuthoredText text={text} /></div></> : <>
          {row.kind === 'chat_error' && row.usageLimit && <><strong>{usageLimitTitle(row.usageLimit)}</strong><p>{usageLimitResetText(row.usageLimit) ? `Reset reported: ${usageLimitResetText(row.usageLimit)}. Retry manually when access is available.` : 'The provider did not report a reset time. Retry manually when access is available.'}</p></>}
          <Markdown text={text} sessionId={sessionId} messageId={row.kind === 'assistant_message' ? row.messageId : undefined}
            nativeMarkup={row.nativeMarkup} originalUrl={originalUrl} />{row.kind === 'assistant_message' && row.final && <AnswerActions text={text} />}</>}
    </article>;
  })}</>;
}
