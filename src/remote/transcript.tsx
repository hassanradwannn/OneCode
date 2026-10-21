import { useEffect, useRef } from 'react';
import { Marked } from 'marked';
import type { ControlApiEvent } from '../shared/control-api.js';
import type { AgentPlan } from '../shared/agent-plan.js';
import { chronological } from '../shared/chronology.js';
import { hasProviderDirective, withoutProviderDirectives } from '../shared/content-reference.js';
import { formatMessageContent, MESSAGE_TAGS, MESSAGE_DROP_TAGS, MAX_MESSAGE_MARKUP } from '../renderer/message-format.js';
import { sanitizeHtmlTree } from '../renderer/sanitize-html.js';
import { drawMath, mathExtensions, separateDisplayMath, type MathSlots } from '../renderer/math.js';
import { renderAgentPlan } from '../renderer/agent-plan.js';
import { RichPresentation } from './presentation.js';
import { Icon } from './composer-controls.js';

async function copyText(value: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(value); return true; } catch { return false; }
}
export function Markdown({ text }: { text: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = host.current; if (!box) return;
    const source = text.slice(0, MAX_MESSAGE_MARKUP), math: MathSlots = { formulas: [] };
    const parser = new Marked({ gfm: true, extensions: mathExtensions(math) });
    const template = document.createElement('template');
    template.innerHTML = parser.parse(separateDisplayMath(source), { async: false });
    const languages = new WeakMap<Element, string>();
    for (const code of template.content.querySelectorAll('pre > code')) {
      const language = code.className.match(/(?:^|\s)language-([a-z0-9_+#.-]{1,24})(?=\s|$)/i)?.[1];
      if (language) languages.set(code, language.toLowerCase());
    }
    sanitizeHtmlTree(template.content, { allowedTags: MESSAGE_TAGS, dropTags: MESSAGE_DROP_TAGS, preserveDirection: true,
      safeHref: value => { const href = value.trim(); if (href.startsWith('#')) return href;
        try { return ['https:', 'http:', 'mailto:'].includes(new URL(href).protocol) ? href : null; } catch { return null; } } });
    box.replaceChildren(template.content);
    if (!box.textContent?.trim() && source) box.textContent = source;
    formatMessageContent(box, { languages, copy: copyText }); drawMath(box, math);
  }, [text]);
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
export function Transcript({ events, sessionId, openRequestId }: { events: ControlApiEvent[]; sessionId: string; openRequestId: string | null }) {
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
    if (row.kind === 'assistant_message' && !text.trim()) return null;
    if (!row.presentation && ['progress', 'page_tool'].includes(row.kind)) return <div className="activity-row" key={row.position}><Icon name="check-circle" /><span>{text || row.label || 'Working'}</span></div>;
    return <article key={row.position} className={row.kind === 'user_message' ? 'human' : row.kind === 'chat_error' ? 'chat-error' : 'message'}>
      {row.presentation || row.kind === 'native_image' || row.kind === 'native_video'
        ? <RichPresentation event={row} sessionId={sessionId} openRequestId={openRequestId} ended={!!row.turnId && events.some(event => event.kind === 'turn_end' && event.turnId === row.turnId)} />
        : row.kind === 'user_message' ? <div className="msg" dir="auto">{text}</div> : <><Markdown text={text} />{row.kind === 'assistant_message' && row.final && <AnswerActions text={text} />}</>}
    </article>;
  })}</>;
}
