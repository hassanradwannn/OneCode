import type { ChatModelOption } from '../shared/chat-models.js';

const paths: Record<string, string> = {
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
  const selected = models.find(row => row.id === model);
  return <details className="model-menu" key={disabled ? 'disabled' : 'enabled'}>
    <summary aria-label="Model and thinking effort" aria-disabled={disabled} onClick={event => { if (disabled) event.preventDefault(); }}>
      <span>{selected?.label ?? (model ? `${model} · unavailable` : 'Automatic')}{effort ? ` · ${effort}` : ''}</span><Icon name="chevron" />
    </summary>
    <div className="model-popover" role="group" aria-label="Model choices">
      <button type="button" data-model="" aria-pressed={!model} disabled={disabled} onClick={() => choose('', '')}>Automatic</button>
      {models.filter(row => !row.id.endsWith('-current')).map(row => <button key={row.id} type="button" data-model={row.id} disabled={disabled} aria-pressed={row.id === model} onClick={() => choose(row.id, '')}>{row.label}</button>)}
      {!!selected?.efforts.length && <><small>Thinking effort</small><div className="effort-options"><button type="button" data-effort="" disabled={disabled} aria-pressed={!effort} onClick={() => choose(model, '')}>Default</button>{selected.efforts.map(value => <button type="button" data-effort={value} key={value} disabled={disabled} aria-pressed={effort === value} onClick={() => choose(model, value)}>{value}</button>)}</div></>}
      <button type="button" disabled={disabled} onClick={refresh}>Refresh models</button>
    </div>
  </details>;
}
