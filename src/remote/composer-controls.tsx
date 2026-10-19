import { useEffect, useRef, useState } from 'react';
import { EFFORT_NAMES, COMPOSER_EFFORTS, resolveChatModel, type ChatModelOption } from '../shared/chat-models.js';

const paths: Record<string, string> = {
  skill: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  copy: 'M9 9h12v12H9zM15 9V3H3v12h6', download: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
  'check-circle': 'M22 11a10 10 0 1 1-6-9M8 11l4 4L22 4', warning: 'M12 3 1 21h22L12 3ZM12 9v5M12 17h.01',
  bolt: 'm13 2-9 12h7l-1 8 10-12h-7l1-8', refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 4M18 18A8 8 0 0 1 5 14',
  plus: 'M12 5v14M5 12h14', send: 'M12 19V5M5 12l7-7 7 7', stop: 'M7 7h10v10H7z',
  chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2v-9.5A8.5 8.5 0 0 1 10.5 4h2a8.5 8.5 0 0 1 8.5 7.5Z',
  tasks: 'M9 6h12M9 12h12M9 18h12M3 6h.01M3 12h.01M3 18h.01',
  settings: 'M9 3h6v2l2 1 2-1 3 5-2 1v2l2 1-3 5-2-1-2 1v2H9v-2l-2-1-2 1-3-5 2-1v-2l-2-1 3-5 2 1 2-1V3Z',
  chevron: 'm8 10 4 4 4-4', expand: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5', collapse: 'M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5', plan: 'M9 6h12M9 12h12M9 18h12M3 6l1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2',
  mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8'
};
export function Icon({ name }: { name: string }) {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill={name === 'stop' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name] ?? paths.plus} />{name === 'settings' && <circle cx="12" cy="12" r="3" />}</svg>;
}
export function ModelMenu({ models, model, effort, disabled, choose, refresh }: {
  models: ChatModelOption[]; model: string; effort: string; disabled: boolean;
  choose(model: string, effort: string): void; refresh(): void;
}) {
  const selected = resolveChatModel(models, model), root = useRef<HTMLDetailsElement>(null);
  const [showModels, setShowModels] = useState(false);
  const supported = COMPOSER_EFFORTS.filter(value => selected?.efforts.includes(value));
  const label = EFFORT_NAMES[effort] ?? 'Automatic';
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && root.current) root.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && root.current?.open) { root.current.open = false; root.current.querySelector('summary')?.focus(); } };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, []);
  return <details ref={root} className="model-menu" onToggle={() => { if (root.current?.open) setShowModels(!selected?.efforts.length); }}>
    <summary aria-label="Model and thinking effort" aria-disabled={disabled} onClick={event => { if (disabled) event.preventDefault(); }}>
      <span>{selected?.label ?? (model ? `${model} · unavailable` : 'Automatic')}{effort ? ` · ${label}` : ''}</span><Icon name="chevron" />
    </summary>
    <div className="model-popover" role="group" aria-label="Model choices">
      <header className="power-header"><Icon name="bolt" /><strong>{label}</strong><button type="button" title="Refresh models" aria-label="Refresh models" disabled={disabled} onClick={refresh}><Icon name="refresh" /></button></header>
      <button type="button" className="power-model" aria-expanded={showModels} onClick={() => setShowModels(value => !value)}>{selected?.label ?? 'Choose model'}<Icon name="chevron" /></button>
      {showModels ? <div className="model-choices"><button type="button" data-model="" aria-pressed={!model} disabled={disabled} onClick={() => { choose('', ''); if (root.current) root.current.open = false; }}>Automatic</button>
        {models.filter(row => !row.id.endsWith('-current')).map(row => <button key={row.id} type="button" data-model={row.id} disabled={disabled} aria-pressed={row.id === selected?.id} onClick={() => { choose(row.id, ''); setShowModels(false); if (!row.efforts.length && root.current) root.current.open = false; }}>{row.label}{row.id === selected?.id && <span>✓</span>}</button>)}
      </div> : !!supported.length && <div className="power-effort"><input type="range" aria-label="Thinking effort" aria-valuetext={label} min={0} max={supported.length - 1} step={1} value={Math.max(0, supported.indexOf(effort as typeof supported[number]))} disabled={disabled} onChange={event => choose(selected!.id, supported[Number(event.target.value)]!)} />
        <div className="power-endpoints"><span>{EFFORT_NAMES[supported[0]!]}</span><span>{EFFORT_NAMES[supported.at(-1)!]}</span></div>
        <button type="button" className="effort-default" data-effort="" onClick={() => choose(selected!.id, '')}>Automatic effort</button>
      </div>}
    </div>
  </details>;
}

type SpeechEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
type SpeechRecognizer = { lang: string; interimResults: boolean; start(): void; stop(): void; onresult: ((event: SpeechEvent) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };
export function DictationButton({ append, disabled }: { append(value: string): void; disabled: boolean }) {
  const [listening, setListening] = useState(false), recognizer = useRef<SpeechRecognizer | null>(null);
  useEffect(() => () => recognizer.current?.stop(), []);
  const Constructor = (window as unknown as { SpeechRecognition?: new () => SpeechRecognizer; webkitSpeechRecognition?: new () => SpeechRecognizer }).SpeechRecognition
    ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognizer }).webkitSpeechRecognition;
  return <button type="button" className={`dictation-control${listening ? ' is-listening' : ''}`} aria-label={listening ? 'Stop dictation' : 'Dictate message'} title={Constructor ? 'Dictate using this device’s microphone' : 'Dictation is unavailable in this browser'} disabled={disabled || !Constructor} onClick={() => {
    if (listening) { recognizer.current?.stop(); return; } if (!Constructor) return;
    const next = new Constructor(); recognizer.current = next; next.lang = navigator.language; next.interimResults = false;
    next.onresult = event => { const value = Array.from(event.results).map(row => row[0]?.transcript ?? '').join(' '); if (value.trim()) append(value); };
    next.onend = next.onerror = () => setListening(false); try { next.start(); setListening(true); } catch { setListening(false); }
  }}><Icon name="mic" /></button>;
}
