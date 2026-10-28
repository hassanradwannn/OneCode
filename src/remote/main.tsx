import type { ChatSchedule } from '../shared/chat-schedules.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { RemoteBootstrap, RemotePreferences, RemoteSession, RemoteSessionDetail, RemoteSessionList } from '../shared/remote.js';
import type { ControlApiEvents, ControlApiInput, ControlApiInputs } from '../shared/control-api.js';
import type { ChatProvider } from '../shared/chat-provider.js';
import type { ReasoningEffort } from '../shared/session.js';
import { request, action, setRemoteToken, hasRemoteToken, hasRemoteLink, connectRemote, reconnectRemote, forgetRemoteLink, RemoteRequestError, RemoteActionError } from './api.js';
import '../renderer/chat-content.css';
import './remote.css';
import './presentations.css';
import { Icon, ModelMenu, DictationButton } from './composer-controls.js';
import { Transcript, CurrentPlan } from './transcript.js';
import { useComposerCompletion } from './composer-completion.js';
import { resolveChatModel, type NativeModelSurface } from '../shared/chat-models.js';
import '../renderer/icons.css';
import type { InputAttachment } from '../shared/input.js';
import { historyRoute, mergeHistory } from './history.js';
import { pendingMessages, retireSubmittedDraft, type OptimisticMessage } from './pending-messages.js';
import { settleRemotePoll } from './poll.js';

type RemoteAppearance = { theme: 'system' | 'dark' | 'light'; textSize: 'default' | 'large' | 'extra' };
function loadAppearance(): RemoteAppearance {
  try { const value = JSON.parse(localStorage.getItem('onecode-remote-appearance') ?? '{}'); return {
    theme: ['system', 'dark', 'light'].includes(value.theme) ? value.theme : 'system', textSize: ['default', 'large', 'extra'].includes(value.textSize) ? value.textSize : 'default' }; }
  catch { return { theme: 'system', textSize: 'default' }; }
}

function ScheduledChecks() {
  const [rows, setRows] = useState<ChatSchedule[]>([]), [error, setError] = useState('');
  const [cancelling, setCancelling] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => { void request<ChatSchedule[]>('schedules', undefined, controller.signal).then(value => {
      if (!controller.signal.aborted) { setRows(value); setError(''); }
    }).catch(error => { if (!controller.signal.aborted) setError((error as Error).message); }); };
    refresh(); const timer = setInterval(refresh, 5000);
    return () => { clearInterval(timer); controller.abort(); };
  }, []);
  return <section><h2>Scheduled checks</h2><p className="muted">Ask ChatGPT or Gemini to repeat a message at an interval until cancelled. Keep OneCode running, the PC awake and the provider signed in.</p>
    {error && <p role="alert">{error}</p>}{!rows.length && <p>No scheduled checks.</p>}
    {rows.map(row => <div className="setting" key={row.id}><span>{row.title}<small>{row.provider === 'gemini' ? 'Gemini' : 'ChatGPT'} · {row.intervalMinutes} min · {row.enabled ? new Date(row.nextRunAt).toLocaleString() : 'Cancelled'}</small>
      <small>{row.lastError || row.runs.at(-1)?.detail || (row.runs.length ? `Last scheduled message: ${row.runs.at(-1)!.state}` : '')}</small><small>{row.message}</small></span>
      {row.enabled && <button disabled={cancelling === row.id} onClick={async () => { setCancelling(row.id); try {
        const changed = await action<ChatSchedule>({action:'cancelSchedule',id:crypto.randomUUID(),scheduleId:row.id});
        setRows(rows => rows.map(item => item.id === changed.id ? changed : item));
      } catch (error) { setError((error as Error).message); } finally { setCancelling(null); } }}>Cancel schedule</button>}</div>)}
    <p className="muted">A queued or sent message is not proof the check succeeded.</p></section>;
}

function Settings({ bootstrap, refresh, back, appearance, saveAppearance, disconnect }: { bootstrap: RemoteBootstrap; refresh(): Promise<RemoteBootstrap>; back(): void; appearance: RemoteAppearance; saveAppearance(value: RemoteAppearance): void; disconnect(): void }) {
  const [tab, setTab] = useState('Chats'), [draft, setDraft] = useState<RemotePreferences>(bootstrap.preferences), [revision, setRevision] = useState(bootstrap.preferencesRevision);
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [browser, setBrowser] = useState(appearance);
  const baseline = useRef(bootstrap.preferences);
  const update = <K extends keyof RemotePreferences>(key: K, value: RemotePreferences[K]) => { setDraft(previous => ({ ...previous, [key]: value })); setMessage('Unsaved changes'); };
  const bool = (label: string, key: keyof RemotePreferences, hint: string) => <label className="setting"><span>{label}<small>{hint}</small></span><input type="checkbox" checked={draft[key] === true} onChange={event => update(key, event.target.checked as never)} /></label>;
  const provider = bootstrap.providers.find(row => row.id === draft.chatProvider) ?? bootstrap.providers[0]!;
  const defaultModel = provider.models.models.find(row => row.id === draft.defaultChatModel);
  const save = async () => {
    setBusy(true); setMessage('');
    const changes = Object.fromEntries(Object.entries(draft).filter(([key, value]) => value !== baseline.current[key as keyof RemotePreferences]).map(([key, value]) => [key, value === undefined ? '' : value]));
    try {
      if (Object.keys(changes).length) {
        const result = await action<{ preferences: RemotePreferences; preferencesRevision: string }>({ action: 'preferences', id: crypto.randomUUID(), expectedRevision: revision, changes });
        setDraft(result.preferences); baseline.current = result.preferences; setRevision(result.preferencesRevision); await refresh();
      }
      saveAppearance(browser); setMessage('Saved');
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  };
  return <section className="settings"><button onClick={back}>← Chat</button><h1>Settings</h1><p className="muted">Preferences on {bootstrap.host}</p><nav className="settings-tabs" aria-label="Settings categories">{['Chats', 'Automation', 'Workspace', 'Appearance', 'Notifications', 'Remote access'].map(name => <button key={name} aria-pressed={name === tab} onClick={() => setTab(name)}>{name}</button>)}</nav>
    {tab === 'Chats' && <><label className="setting"><span>Default provider<small>Applies to new chats. Existing chats keep their provider.</small></span><select value={draft.chatProvider} onChange={event => { update('chatProvider', event.target.value as ChatProvider); update('defaultChatModel', ''); update('defaultChatReasoning', undefined); update('defaultChatModelAffinity', undefined); }}>{bootstrap.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
      <label className="setting"><span>Default model<small>Choices observed on the host provider page.</small></span><select value={draft.defaultChatModel ?? ''} onChange={event => { const model = event.target.value, choice = resolveChatModel(provider.models.models, model); update('defaultChatModel', model); update('defaultChatReasoning', undefined); update('defaultChatModelAffinity', choice?.nativeSurface ? { provider: provider.id, model, surface: choice.nativeSurface } : undefined); }}><option value="">Automatic</option>{!!draft.defaultChatModel && !defaultModel && <option value={draft.defaultChatModel}>{draft.defaultChatModel} · Previously observed</option>}{provider.models.models.filter(model => !model.id.endsWith('-current')).map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
      {!!defaultModel?.efforts.length && <label className="setting"><span>Thinking effort</span><select value={draft.defaultChatReasoning ?? ''} onChange={event => update('defaultChatReasoning', event.target.value as ReasoningEffort)}><option value="">Provider default</option>{defaultModel.efforts.map(effort => <option key={effort}>{effort}</option>)}</select></label>}
      <label className="setting"><span>Messages during a running task</span><select value={draft.followUp ?? 'steer'} onChange={event => update('followUp', event.target.value as 'steer' | 'queue')}><option value="steer">Send new direction immediately</option><option value="queue">Queue after this turn</option></select></label>{bool('Enter to send', 'enterSends', 'Shift+Enter adds a new line.')}</>}
    {tab === 'Automation' && <><ScheduledChecks />{bool('Automatic continuation', 'autoContinue', 'Continue eligible interrupted responses.')}{bool('Automatic skill selection', 'autoSelectSkills', 'Choose relevant installed skills for new messages.')}<label className="setting"><span>Rotate long turns after (minutes)<small>0 disables scheduled rotation.</small></span><input type="number" min={0} max={120} value={draft.rotateTurnMinutes ?? 0} onChange={event => update('rotateTurnMinutes', Number(event.target.value))} /></label></>}
    {tab === 'Workspace' && <>{bool('Background chats', 'backgroundChats', 'Open app-created provider chats in the background.')}<label className="setting"><span>Background placement</span><select value={draft.backgroundPlacement ?? 'window'} onChange={event => update('backgroundPlacement', event.target.value as 'window' | 'group')}><option value="window">Separate window</option><option value="group">Browser tab group</option></select></label><label className="setting"><span>Provider tabs to retain</span><input type="number" min={1} max={50} value={draft.tabsToKeepOpen ?? 8} onChange={event => update('tabsToKeepOpen', Number(event.target.value))} /></label></>}
    {tab === 'Appearance' && <><label className="setting"><span>Remote theme<small>This browser</small></span><select value={browser.theme} onChange={event => { setBrowser(value => ({ ...value, theme: event.target.value as RemoteAppearance['theme'] })); setMessage('Unsaved changes'); }}><option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option></select></label><label className="setting"><span>Text size<small>This browser</small></span><select value={browser.textSize} onChange={event => { setBrowser(value => ({ ...value, textSize: event.target.value as RemoteAppearance['textSize'] })); setMessage('Unsaved changes'); }}><option value="default">Default</option><option value="large">Large</option><option value="extra">Extra large</option></select></label><label className="setting"><span>Host theme</span><select value={draft.theme ?? 'dark'} onChange={event => update('theme', event.target.value as 'dark' | 'light')}><option value="dark">Dark</option><option value="light">Light</option></select></label>{bool('Follow new output', 'followOutput', 'Stop following when you scroll up.')}</>}
    {tab === 'Notifications' && bool('Task completion notifications', 'turnNotifications', 'Completion notifications on the host PC.')}
    {tab === 'Remote access' && <><div className="setting"><span>{bootstrap.host}<small>Private Tailscale connection</small></span><span className="connected">Connected</span></div><div className="setting"><span>This browser<small>Disconnect this browser without changing other devices.</small></span><button onClick={disconnect}>Disconnect this browser</button></div></>}
    <footer><span role="status">{message}</span><button className="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button><button onClick={async () => { const value = await refresh(); setDraft(value.preferences); baseline.current = value.preferences; setRevision(value.preferencesRevision); setMessage('Reloaded'); }}>Reload host preferences</button></footer></section>;
}

function Workspace({ disconnect, initialBootstrap }: { disconnect(): void; initialBootstrap: RemoteBootstrap | null }) {
  const [bootstrap, setBootstrap] = useState<RemoteBootstrap | null>(initialBootstrap), [sessions, setSessions] = useState<RemoteSession[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null);
  const [newProject, setNewProject] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState<RemoteSessionDetail | null>(null), [events, setEvents] = useState<ControlApiEvents['events']>([]), [inputs, setInputs] = useState<ControlApiInput[]>([]);
  const [provider, setProvider] = useState<ChatProvider | null>(initialBootstrap?.preferences.chatProvider ?? initialBootstrap?.providers[0]?.id ?? null), [model, setModel] = useState(''), [effort, setEffort] = useState(''), [draft, setDraft] = useState(''), [view, setView] = useState('chat');
  const [modelSurface, setModelSurface] = useState<NativeModelSurface | undefined>();
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [connected, setConnected] = useState(false), [sending, setSending] = useState(false), [pending, setPending] = useState<string | null>(null), [editing, setEditing] = useState(false), [title, setTitle] = useState('');
  const [optimistic, setOptimistic] = useState<OptimisticMessage[]>([]);
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const [appearance, setAppearance] = useState(loadAppearance);
  const [mode, setMode] = useState<'off' | 'goal' | 'loop'>('off'), [modeChanged, setModeChanged] = useState(false);
  const [attachments, setAttachments] = useState<InputAttachment[]>([]), [uploading, setUploading] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<{ id: string; name: string; src: string } | null>(null), [previewingAttachment, setPreviewingAttachment] = useState<string | null>(null);
  const [skills, setSkills] = useState<Array<{ id: string; name: string; description: string }>>([]), [showSkills, setShowSkills] = useState(false);
  const [focusOpenId, setFocusOpenId] = useState<string | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null), [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierFailed, setEarlierFailed] = useState(false);
  const earlierFlight = useRef<object | null>(null);
  const [skillsLoaded, setSkillsLoaded] = useState(false), [skillsLoading, setSkillsLoading] = useState(false), [modelEdited, setModelEdited] = useState(false);
  type PlanDraft = { key: string; text: string; stages: string[] | null; requestId: string | null; busy: boolean; error: string; unconfirmed?: boolean };
  const [plan, setPlan] = useState<PlanDraft | null>(null), plans = useRef(new Map<string, PlanDraft>());
  const input = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null), addMenu = useRef<HTMLDetailsElement>(null), attachmentDrafts = useRef(new Map<string, InputAttachment[]>());
  const saveAppearance = (value: RemoteAppearance) => { setAppearance(value); try { localStorage.setItem('onecode-remote-appearance', JSON.stringify(value)); } catch { /* in-memory preference */ } };
  const selectedRef = useRef(selected), draftRef = useRef(draft), drafts = useRef(new Map<string, string>()), pane = useRef<HTMLDivElement>(null), following = useRef(true), boot = useRef(bootstrap);
  const composerKey = selected ?? `new:${newProject ?? ''}`;
  const composerKeyRef = useRef(composerKey); composerKeyRef.current = composerKey;
  selectedRef.current = selected; draftRef.current = draft; boot.current = bootstrap;
  const pendingTarget = useRef<string | null>(null), pendingDraft = useRef(''), listLoaded = useRef(false);
  const refreshBootstrap = async () => { const value = await request<RemoteBootstrap>('bootstrap'); setBootstrap(value); return value; };
  useEffect(() => { if (bootstrap && provider === null) setProvider(bootstrap.preferences.chatProvider ?? bootstrap.providers[0]!.id); }, [bootstrap, provider]);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const seenPresentations = new Set<string>(); let historyInitialized = false, historyFrom: number | undefined, skipBootstrapOnce = initialBootstrap !== null;
    const poll = async () => {
      const fresh = () => !controller.signal.aborted && selectedRef.current === selected;
      const tasks: Array<() => Promise<void>> = [];
      tasks.push(async () => {
        // Keep each browser below the host's bounded journal reader limit.
        const list = await request<RemoteSessionList>('sessions?limit=50', undefined, controller.signal);
        if (!fresh()) return;
        setSessions(previous => [...list.sessions.filter(row => row.conversationId || row.origin?.kind === 'desktop'), ...previous.filter(row => !list.sessions.some(current => current.id === row.id))]);
        if (!listLoaded.current) { listLoaded.current = true; setNextCursor(list.nextCursor); }
      });
      tasks.push(async () => {
        const queued = await request<ControlApiInputs>('inputs?limit=200', undefined, controller.signal);
        if (!fresh()) return;
        setInputs(queued.inputs);
        if (pendingRef.current) { const input = queued.inputs.find(row => row.id === pendingRef.current); if (input) { setOptimistic(rows => rows.map(row => row.id === input.id ? { ...row, sessionId: input.deliveredSessionId ?? input.sessionId, receipt: input } : row)); setPending(null); setSending(false); retireSubmittedDraft(drafts.current, attachmentDrafts.current, pendingTarget.current, pendingDraft.current); if (composerKeyRef.current === pendingTarget.current) { if (draftRef.current === pendingDraft.current) { setDraft(''); setAttachments([]); } if (input.deliveredSessionId ?? input.sessionId) setSelected(input.deliveredSessionId ?? input.sessionId); } setNotice(''); } }
      });
      if (selected) tasks.push(async () => {
        const snapshot = await request<RemoteSessionDetail>(`sessions/${selected}?live=1`, undefined, controller.signal);
        if (fresh()) setDetail(snapshot);
      });
      if (selected) tasks.push(async () => {
        const history = await request<ControlApiEvents>(historyRoute(selected, historyFrom), undefined, controller.signal);
        if (!fresh()) return;
        if (history) {
          for (const event of history.events) if (event.presentation?.openId) {
            const id = event.presentation.openId;
            if (historyInitialized && !seenPresentations.has(id)) setFocusOpenId(id);
            seenPresentations.add(id);
          }
          if (!historyInitialized) setNextBefore(history.nextBefore ?? null);
          historyInitialized = true; historyFrom = history.nextFrom;
          setEvents(previous => mergeHistory(previous, history.events));
        }
      });
      if (skipBootstrapOnce) skipBootstrapOnce = false;
      else tasks.push(async () => {
        const value = await request<RemoteBootstrap>('bootstrap', undefined, controller.signal);
        if (fresh()) setBootstrap(value);
      });
      const failures = await settleRemotePoll(tasks);
      if (!fresh()) return;
      const relevant = failures.filter(error => !(error instanceof RemoteRequestError && error.status === 503 && error.message === 'busy'));
      if (relevant.length) {
        const failed = (relevant.find(error => !(error instanceof RemoteRequestError) || error.status === 401 || error.status >= 500) ?? relevant[0]) as Error;
        // A rejected history query is an application error, not a lost transport.
        if (!(failed instanceof RemoteRequestError) || failed.status === 401 || failed.status >= 500) setConnected(false);
        else setConnected(true);
        setError(failed.message === 'invalid_query' ? 'Chat history could not load. Reload this page to use the updated client.' : failed.message);
      } else if (!failures.length) { setConnected(true); setError(''); }
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 2500);
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [selected]);
  useEffect(() => { if (following.current && boot.current?.preferences.followOutput !== false) pane.current?.scrollTo({ top: pane.current.scrollHeight }); }, [events, optimistic]);
  useEffect(() => {
    const node = pane.current;
    if (selected && nextBefore !== null && !loadingEarlier && !earlierFailed && node && node.scrollHeight <= node.clientHeight + 96) void loadEarlier();
  }, [selected, nextBefore, loadingEarlier, earlierFailed, events.length]);
  function select(id: string | null, projectId: string | null = null): void {
    const nextKey = id ?? `new:${projectId ?? ''}`;
    setNewProject(projectId);
    earlierFlight.current = null; setEarlierFailed(false);
    setFocusOpenId(null);
    attachmentDrafts.current.set(composerKey, attachments); setAttachments(attachmentDrafts.current.get(nextKey) ?? []); setMode('off'); setModeChanged(false);
    drafts.current.set(composerKey, draft); setSelected(id); setDetail(null); setEvents([]); setNextBefore(null); setLoadingEarlier(false); setNotice(''); setPlan(plans.current.get(nextKey) ?? null); setDraft(drafts.current.get(nextKey) ?? ''); setView('chat'); setModel(''); setEffort(''); setModelSurface(undefined); setModelEdited(false); setEditing(false); following.current = true;
    if (id === null) setProvider(bootstrap?.preferences.chatProvider ?? null);
    else void action<import('../shared/chat-readiness.js').SelectedChatReadiness>({ action: 'selectChat', id: crypto.randomUUID(), sessionId: id })
      .catch(error => { if (selectedRef.current === id) setError((error as Error).message); });
  }
  const currentDetail = detail?.session.id === selected ? detail : null;
  const summary = currentDetail?.session ?? sessions.find(row => row.id === selected), activeTurn = currentDetail?.live?.activeTurnId ?? null;
  const unfinishedTurn = currentDetail?.live?.unfinishedTurnId ?? activeTurn;
  const actualProvider = selected ? summary?.provider ?? null : provider;
  const actualMode = modeChanged || !selected ? mode : (['goal', 'loop'].includes(currentDetail?.live?.automation ?? '') ? currentDetail!.live!.automation as 'goal' | 'loop' : 'off');
  const catalog = bootstrap?.providers.find(row => row.id === actualProvider);
  const currentModel = resolveChatModel(catalog?.models.models ?? [], model);
  useEffect(() => {
    if (modelEdited || !catalog) return;
    const observed = currentDetail?.selection;
    const saved = !selected && actualProvider === bootstrap?.preferences.chatProvider ? bootstrap.preferences : null;
    const nextModel = observed?.model ?? saved?.defaultChatModel ?? '';
    const affinity = saved?.defaultChatModelAffinity;
    setModel(nextModel); setEffort(observed?.reasoningEffort ?? saved?.defaultChatReasoning ?? '');
    setModelSurface(observed?.modelSurface ?? (affinity?.provider === actualProvider && affinity.model === nextModel ? affinity.surface :
      !selected ? resolveChatModel(catalog.models.models, nextModel)?.nativeSurface : undefined));
  }, [selected, currentDetail?.selection?.model, currentDetail?.selection?.reasoningEffort, currentDetail?.selection?.modelSurface, actualProvider, catalog?.models.observedAt, modelEdited, bootstrap?.preferences.defaultChatModelAffinity]);
  const activePlan = plan?.key === (composerKey) ? plan : null;
  const planInvalid = !!activePlan?.stages && (!activePlan.stages.length || activePlan.stages.some(stage => !stage.trim()) || JSON.stringify(activePlan.stages).length > 12000);
  const delivering = inputs.some(row => (row.sessionId === selected || row.deliveredSessionId === selected) && !!selected && !row.automatic && row.delivery === 'pending' && row.state === 'queued');
  const verifyModelSurface = actualProvider === 'chatgpt' && !!model && !!modelSurface && currentModel?.nativeSurface !== modelSurface;
  const modelProblem = verifyModelSurface ? '' : model && !currentModel ? 'This model is unavailable. Choose a model from the current provider.'
    : effort && !currentModel?.efforts.includes(effort as ReasoningEffort) ? 'Choose a supported thinking effort.' : '';
  const send = async (event: FormEvent) => {
    event.preventDefault(); if (!draft.trim() || sending || pending || uploading || activePlan?.busy || activePlan?.unconfirmed || planInvalid || !actualProvider || (selected && !currentDetail)) return;
    if (activePlan && !activePlan.stages) { await preparePlan(); return; }
    if (modelProblem) { setError(modelProblem); return; }
    const id = crypto.randomUUID(), target = selected, targetKey = composerKey; pendingTarget.current = targetKey; pendingDraft.current = draft; setSending(true); setError(''); setPending(id);
    setOptimistic(rows => [...rows, { id, sessionId: target, composerKey: targetKey, text: draft.trim(), state: 'sending' }]);
    try {
      const result = await action<{ input: ControlApiInput }>({ action: 'send', id, sessionId: selected, projectId: selected ? summary?.projectId ?? null : newProject, provider: actualProvider, text: draft.trim(), model: model || null, reasoningEffort: effort || null, ...(modelSurface ? { modelSurface } : {}), expectedTurnId: unfinishedTurn,
        ...(modeChanged || !selected ? { automation: actualMode } : {}), ...(attachments.length ? { attachments } : {}), ...(activePlan?.stages ? { plan: activePlan.stages } : {}),
        afterTurn: !!unfinishedTurn && bootstrap?.preferences.followUp === 'queue' });
      setOptimistic(rows => rows.map(row => row.id === id ? { ...row, sessionId: result.input.deliveredSessionId ?? result.input.sessionId, receipt: result.input, state: 'accepted' } : row));
      retireSubmittedDraft(drafts.current, attachmentDrafts.current, targetKey, pendingDraft.current);
      if (composerKeyRef.current === targetKey) { if (draftRef.current === pendingDraft.current) { setDraft(''); drafts.current.delete(targetKey); setAttachments([]); attachmentDrafts.current.delete(targetKey); } if (result.input.sessionId) setSelected(result.input.sessionId); }
      if (activePlan) { plans.current.delete(activePlan.key); if (composerKeyRef.current === targetKey) setPlan(null); }
      setPending(null); setSending(false); setNotice('');
    } catch (error) {
      setError((error as Error).message); setSending(false);
      setOptimistic(rows => rows.map(row => row.id === id ? { ...row, state: 'unconfirmed' } : row));
      if (error instanceof RemoteRequestError && error.status < 500 && error.status !== 409) { setPending(null); setOptimistic(rows => rows.filter(row => row.id !== id)); }
      else if (error instanceof RemoteActionError) {
        try { if (!await request<ControlApiInput | null>(`inputs/${id}`)) { setPending(null); setOptimistic(rows => rows.filter(row => row.id !== id)); } } catch { /* outcome remains unknown */ }
      }
    }
  };
  const mutate = async (body: Record<string, unknown>) => { try { setError(''); await action({ id: crypto.randomUUID(), ...body }); } catch (error) { setError((error as Error).message); } };
  function updateDraft(value: string): void {
    setDraft(value);
    if (activePlan?.stages && activePlan.text !== value.trim()) { const next = { ...activePlan, stages: null, text: value.trim() }; plans.current.set(next.key, next); setPlan(next); }
  }
  function togglePlan(): void {
    const key = composerKey, current = plans.current.get(key);
    if (current) { if (current.requestId) void mutate({ action: 'cancelPlan', requestId: current.requestId }); plans.current.delete(key); setPlan(null); }
    else { const next = { key, text: '', stages: null, requestId: null, busy: false, error: '' }; plans.current.set(key, next); setPlan(next); }
    input.current?.focus({ preventScroll: true });
  }
  async function preparePlan(): Promise<void> {
    const key = composerKey, text = draft.trim();
    if (!text || text.length > 16000) { setError('Enter a task of at most 16000 characters.'); return; }
    const next: PlanDraft = { key, text, stages: null, requestId: crypto.randomUUID(), busy: true, error: '' };
    plans.current.set(key, next); setPlan(next);
    try {
      const stages = await action<string[]>({ action: 'draftPlan', id: next.requestId, text });
      if (plans.current.get(key) !== next) return;
      next.stages = stages; next.requestId = null;
    } catch (error) { if (plans.current.get(key) === next) { next.error = (error as Error).message; next.unconfirmed = !(error instanceof RemoteActionError) && !(error instanceof RemoteRequestError && error.status < 500); } }
    finally { if (plans.current.get(key) === next) { next.busy = false; if (composerKeyRef.current === key) setPlan({ ...next }); } }
  }
  const completion = useComposerCompletion({ draft, setDraft: updateDraft, input, skills, loading: skillsLoading, sessionId: selected, command: name => {
    if (name === 'new') select(null);
    else if (name === 'model' || name === 'reasoning') { const menu = document.querySelector<HTMLDetailsElement>('.model-menu'); if (menu) menu.open = true; }
    else if (name === 'plan') togglePlan();
    else if (name === 'goal' || name === 'loop') { setMode(name); setModeChanged(true); }
    else if (name === 'rename') { setTitle(summary?.title ?? ''); setEditing(true); }
    else if (name === 'review') updateDraft('Review the uncommitted changes in this project. Look for bugs, regressions and missing tests. List findings by severity with file and line. Do not change files.');
    else if (name === 'init') updateDraft('Read this project and create a concise AGENTS.md describing how to build, test and run it, its layout and coding conventions.');
  } });
  useEffect(() => {
    if (!completion.visible || skillsLoaded) return;
    const controller = new AbortController(); setSkillsLoading(true);
    void request<typeof skills>('skills', undefined, controller.signal).then(value => { if (!controller.signal.aborted) { setSkills(value); setSkillsLoaded(true); } }).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { setSkillsLoading(false); });
    return () => controller.abort();
  }, [completion.visible, skillsLoaded]);
  const upload = async (chosen: FileList | null) => {
    if (!chosen?.length || uploading) return;
    if (addMenu.current) addMenu.current.open = false;
    const targetKey = composerKey; setUploading(true); setError('');
    try {
      if (attachments.length + chosen.length > 20) throw new Error('Attach up to 20 files per message');
      const uploaded: InputAttachment[] = [];
      for (const file of [...chosen]) {
        if (file.size > 16 * 1024 * 1024) throw new Error('Remote attachments must be 16 MB or smaller');
        const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]!); reader.onerror = () => reject(new Error('Could not read this file')); reader.readAsDataURL(file); });
        uploaded.push(await request<InputAttachment>('attachments', { name: file.name, data }));
      }
      if (composerKeyRef.current === targetKey) setAttachments(rows => [...rows, ...uploaded]);
      else attachmentDrafts.current.set(targetKey, [...(attachmentDrafts.current.get(targetKey) ?? []), ...uploaded]);
    } catch (error) { setError((error as Error).message); } finally { setUploading(false); if (files.current) files.current.value = ''; }
  };
  const previewAttachment = async (file: InputAttachment) => {
    if (!file.mimeType.startsWith('image/') || previewingAttachment === file.id) return;
    setPreviewingAttachment(file.id); setError('');
    if (file.preview) setAttachmentPreview({ id: file.id, name: file.name, src: file.preview });
    try {
      const src = await request<string | null>(`attachments/${encodeURIComponent(file.id)}/preview`);
      if (src) setAttachmentPreview({ id: file.id, name: file.name, src });
      else if (!file.preview) throw new Error('This image preview is unavailable.');
    } catch (error) { if (!file.preview) setError((error as Error).message); }
    finally { setPreviewingAttachment(null); }
  };
  const loadEarlier = async (retry = false) => {
    if (!selected || nextBefore === null || earlierFlight.current || loadingEarlier || (earlierFailed && !retry)) return;
    const flight = {}; earlierFlight.current = flight; setEarlierFailed(false);
    const target = selected, before = nextBefore, node = pane.current, height = node?.scrollHeight ?? 0, top = node?.scrollTop ?? 0;
    following.current = false; setLoadingEarlier(true);
    try {
      const page = await request<ControlApiEvents>(`sessions/${encodeURIComponent(target)}/events?before=${before}&limit=100`);
      if (selectedRef.current !== target || earlierFlight.current !== flight) return;
      setEvents(rows => mergeHistory(rows, page.events)); setNextBefore(page.nextBefore ?? null);
      requestAnimationFrame(() => { if (pane.current && selectedRef.current === target) pane.current.scrollTop = top + pane.current.scrollHeight - height; });
    } catch (error) { if (selectedRef.current === target && earlierFlight.current === flight) { setEarlierFailed(true); setError((error as Error).message); } }
    finally {
      if (earlierFlight.current === flight) { earlierFlight.current = null; if (selectedRef.current === target) setLoadingEarlier(false); }
    }
  };
  const taskRow = (session: RemoteSession) => {
    const workers = sessions.filter(row => row.origin?.kind === 'worker' && row.origin.fromSessionId === session.id);
    const row = <button className={`task ${selected === session.id ? 'active' : ''}`} onClick={() => select(session.id)} title={session.title || 'Untitled chat'}><strong>{session.title || 'Untitled chat'}</strong></button>;
    if (!workers.length) return <div className="task-family" key={session.id}>{row}</div>;
    return <details className="task-family worker-family" key={session.id}><summary><span className="task-family-main" onClick={event => { event.preventDefault(); select(session.id); }}>{session.title || 'Untitled chat'}</span><span className="worker-count">{workers.length}</span><Icon name="chevron" /></summary>
      <div className="worker-list">{workers.map(worker => <button key={worker.id} className={`task worker-task ${selected === worker.id ? 'active' : ''}`} onClick={() => select(worker.id)} title={worker.title || worker.origin?.agentId || 'Worker'}><strong>{worker.origin?.agentId ? `${worker.origin.agentId} · ` : ''}{worker.title || 'Worker'}</strong></button>)}</div></details>;
  };
  const visibleSessions = (rows: RemoteSession[]) => rows.filter(session => !(session.origin?.kind === 'worker' && session.origin.fromSessionId && sessions.some(parent => parent.id === session.origin!.fromSessionId)));
  if (!bootstrap) return <main className="pair"><h1>Loading OneCode…</h1><p role="alert">{error}</p><button onClick={() => location.reload()}>Reconnect</button></main>;
  return <div className="app" data-view={view} data-theme={bootstrap.preferences.theme} data-remote-theme={appearance.theme} data-text-size={appearance.textSize}><header className="top"><div className="brand">◈ OneCode <small>Remote</small></div><span className={connected ? 'connected' : 'muted'}>{connected ? '●' : '○'} {bootstrap.host} · {connected ? 'Connected' : 'Reconnecting'}</span></header><div className="body">
    <aside className={view === 'tasks' ? 'visible' : ''}><button onClick={() => select(null)}>＋ New chat</button>
      <div className="task-list">{(bootstrap.projects ?? []).map(project => <details className="project-group" key={project.id} open data-project-color={project.color}>
        <summary><span>{project.name}</span><button aria-label={`New chat in ${project.name}`} onClick={event => { event.preventDefault(); select(null, project.id); }}>＋</button></summary>
        {visibleSessions(sessions.filter(session => session.projectId === project.id)).map(taskRow)}
      </details>)}<p className="eyebrow">Chats</p>{visibleSessions(sessions.filter(session => !(bootstrap.projects ?? []).some(project => project.id === session.projectId))).map(taskRow)}
      {nextCursor && <button onClick={async () => { const page = await request<RemoteSessionList>(`sessions?limit=50&cursor=${encodeURIComponent(nextCursor)}`); setSessions(rows => [...rows, ...page.sessions.filter(row => !rows.some(existing => existing.id === row.id))]); setNextCursor(page.nextCursor); }}>Load more</button>}</div><button className="settings-link" aria-current={view === 'settings' ? 'page' : undefined} onClick={() => setView('settings')}><Icon name="settings" /> Settings</button></aside>
    {view === 'settings' ? <Settings bootstrap={bootstrap} appearance={appearance} saveAppearance={saveAppearance} refresh={refreshBootstrap} back={() => setView('chat')} disconnect={() => { void request('disconnect', {}).catch(() => undefined).finally(() => { setRemoteToken(''); disconnect(); }); }} /> : <main className={view === 'tasks' ? 'mobile-hidden' : ''}><header className="chat-heading"><div className="heading-line"><h1>{selected ? summary?.title || 'Loading task…' : newProject ? `New chat · ${bootstrap.projects?.find(project => project.id === newProject)?.name ?? 'Project unavailable'}` : 'New chat'}</h1>{!selected && !sending && !pending ? <select aria-label="Provider for this chat" disabled={sending || !!pending} value={actualProvider ?? ''} onChange={event => { setProvider(event.target.value as ChatProvider); setModel(''); setEffort(''); setModelSurface(undefined); setModelEdited(true); }}>{bootstrap.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select> : <span className="muted">{catalog?.label}</span>}</div>{selected && <button onClick={() => { setTitle(summary?.title ?? ''); setEditing(value => !value); }}>Edit task</button>}</header>
      {editing && <form className="edit-title" onSubmit={event => { event.preventDefault(); void mutate({ action: 'rename', sessionId: selected, title, expectedTitle: summary?.title ?? '' }); setEditing(false); }}><input aria-label="Task title" value={title} maxLength={120} onChange={event => setTitle(event.target.value)} required /><button>Save title</button></form>}
      <div className="thread" ref={pane} onScroll={() => { const node = pane.current; if (!node) return; following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60; if (node.scrollTop < 96 && nextBefore !== null && !loadingEarlier) void loadEarlier(); }}>
        <div className="transcript">{!selected && <div className="welcome"><h2>What are we working on?</h2><p>Start a task on {bootstrap.host}.</p></div>}
          {selected && loadingEarlier && <div className="history-loading" role="status">Loading earlier messages…</div>}
          {selected && earlierFailed && <button type="button" onClick={() => void loadEarlier(true)}>Retry earlier messages</button>}
          {selected && <Transcript events={events} sessionId={selected} openRequestId={focusOpenId} />}
          {pendingMessages(optimistic, inputs, events, selected, composerKey).map(row => <article className="human optimistic" key={row.id}><div className="msg" dir="auto">{row.text}</div><small>{row.receipt?.delivery === 'sent' ? 'Sent ✓' : row.receipt?.delivery === 'not_sent' ? 'Not sent' : row.state === 'unconfirmed' || row.receipt?.delivery === 'unconfirmed' ? 'Delivery unconfirmed' : 'Sending…'}</small></article>)}
          {activeTurn && <div className="thinking" role="status"><span className="thinking-dot" />{events.some(event => event.turnId === activeTurn && ['assistant_message', 'tool_call'].includes(event.kind)) ? 'Working…' : 'Thinking…'}</div>}
        </div>
      </div><div className="composer-area"><div className="status" role="status">{pending ? 'Checking delivery…' : sending || delivering ? 'Sending…' : activeTurn ? 'Working' : 'Ready'}{notice ? ` · ${notice}` : ''}</div>{inputs.filter(input => input.sessionId === selected && !input.automatic && input.state === 'queued' && input.delivery === 'pending' && ['after-turn', 'finish'].includes(input.mode)).map(input => <div className="queued" key={input.id}><span>Queued after this turn</span><button onClick={() => { void mutate({ action: 'cancel', inputId: input.id }); }}>Cancel</button></div>)}
        <CurrentPlan sessionId={selected} plan={currentDetail?.plan} />
        {currentDetail?.providerReadiness && currentDetail.providerReadiness.phase !== 'ready' && <p className="status" role="status">{
          currentDetail.providerReadiness.phase === 'history-wait' ? `Waiting for provider history until ${new Date(currentDetail.providerReadiness.retryAt ?? Date.now()).toLocaleTimeString()}…`
            : currentDetail.providerReadiness.phase === 'refused' ? currentDetail.providerReadiness.reason ?? 'Provider tab is unavailable.'
              : currentDetail.providerReadiness.phase === 'reconnecting' ? 'Reconnecting provider tab…' : 'Loading provider tab…'
        }</p>}
        {activePlan && <section className="prepared-plan" aria-label="Prepared task plan"><header><Icon name="plan" /><strong>{activePlan.busy ? 'Creating plan…' : activePlan.stages ? 'Plan ready' : 'Plan mode'}</strong><button type="button" aria-label="Cancel plan" onClick={togglePlan}>×</button></header>
          {activePlan.error && <p role="alert">{activePlan.error}</p>}
          {activePlan.unconfirmed && <button type="button" onClick={async () => {
            if (!activePlan.requestId) return;
            try { const receipt = await request<{ state: string; result?: { ok: boolean; data?: string[]; error?: string } } | null>(`operations/${activePlan.requestId}`);
              if (receipt?.state === 'done' && receipt.result) { const next = { ...activePlan, stages: receipt.result.ok ? receipt.result.data ?? null : null, unconfirmed: false, requestId: null, error: receipt.result.error ?? '' }; plans.current.set(next.key, next); setPlan(next); }
            } catch (error) { setError((error as Error).message); }
          }}>Check plan preparation</button>}
          {activePlan.stages?.map((stage, index) => <label className="prepared-stage" key={index}><span>{index + 1}</span><textarea aria-label={`Plan stage ${index + 1}`} value={stage} onChange={event => { const next = { ...activePlan, stages: activePlan.stages!.map((value, at) => at === index ? event.target.value : value) }; plans.current.set(next.key, next); setPlan(next); }} /></label>)}
          {!activePlan.busy && !activePlan.stages && <p>Describe your task, then send to create editable stages.</p>}
        </section>}
        <form className="composer" onSubmit={send}>{completion.menu}<textarea ref={input} rows={2} dir="auto" aria-label="Message" aria-expanded={completion.visible} aria-controls={completion.visible ? 'composer-completion' : undefined} aria-activedescendant={completion.activeId} readOnly={activePlan?.busy} placeholder={activePlan ? 'Describe the task to turn into a plan…' : 'Ask anything…'} value={draft} onSelect={completion.selectionChanged} onChange={event => { updateDraft(event.target.value); completion.selectionChanged(); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`; }} onKeyDown={event => { if (completion.keyDown(event)) return; if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && bootstrap.preferences.enterSends !== false) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          {!!attachments.length && <div className="attachment-chips">{attachments.map(file => <span className="attachment-chip" key={file.id}>{file.mimeType.startsWith('image/')
            ? <button type="button" className="attachment-open" disabled={sending || !!pending} onClick={() => { void previewAttachment(file); }} aria-label={`Preview ${file.name}`}>{file.preview && <img src={file.preview} alt="" />}{file.name}{previewingAttachment === file.id ? ' …' : ''}</button>
            : <span className="attachment-name">{file.name}</span>}<button type="button" className="attachment-remove" disabled={sending || !!pending} onClick={() => setAttachments(rows => rows.filter(row => row.id !== file.id))} aria-label={`Remove ${file.name}`}>×</button></span>)}</div>}
          <div className="composer-toolbar">
            <input ref={files} type="file" multiple hidden onChange={event => { void upload(event.target.files); }} />
            <details className="add-menu" ref={addMenu}><summary aria-label="Add photos, files or skills" aria-disabled={sending || !!pending || uploading} onClick={event => { if (sending || pending || uploading) event.preventDefault(); }}><Icon name="plus" /></summary><div className="model-popover"><button type="button" disabled={uploading || sending || !!pending} onClick={() => files.current?.click()}>Add photos &amp; files</button><button type="button" onClick={async () => { try { setSkills(await request('skills')); setSkillsLoaded(true); setShowSkills(value => !value); } catch (error) { setError((error as Error).message); } }}>Skills <span>＋</span></button>{showSkills && skills.map(skill => <button type="button" key={skill.id} title={skill.description} onClick={() => { updateDraft(`/${skill.id}\n${draft}`); setShowSkills(false); if (addMenu.current) addMenu.current.open = false; }}>{skill.name}</button>)}{showSkills && !skills.length && <small>No installed skills</small>}</div></details>
            <ModelMenu models={catalog?.models.models ?? []} model={model} effort={effort} disabled={sending || !!pending} unverified={verifyModelSurface} choose={(nextModel, nextEffort) => {
              const observed = resolveChatModel(catalog?.models.models ?? [], nextModel);
              setModelSurface(observed?.nativeSurface ?? (nextModel === model ? modelSurface : undefined));
              setModel(nextModel); setEffort(nextEffort); setModelEdited(true);
            }} refresh={async () => { await mutate({ action: 'refreshModels', provider: actualProvider }); await refreshBootstrap(); }} />
            {verifyModelSurface && <small role="status">This previously observed choice will be checked in the browser.</small>}
            <label className="chat-mode" title="Chat mode"><Icon name="chat" /><select aria-label="Chat mode" disabled={sending || !!pending} value={actualMode} onChange={event => { setMode(event.target.value as typeof mode); setModeChanged(true); }}><option value="off">Normal</option><option value="goal">Goal</option><option value="loop">Loop</option></select><Icon name="chevron" /></label>
            <button type="button" className="plan-control" aria-label="Plan" aria-pressed={!!activePlan} onClick={togglePlan}><Icon name="plan" /><span>Plan</span></button>
            <DictationButton disabled={sending || !!pending || !!activePlan?.busy} append={value => updateDraft(`${draftRef.current}${draftRef.current ? ' ' : ''}${value}`)} />
            <div className="actions">{unfinishedTurn && !draft.trim()
              ? <button type="button" className="send-control" aria-label={currentDetail?.live?.stopPending ? 'Stop requested' : 'Stop'} onClick={() => { void mutate({ action: 'stop', sessionId: selected, expectedTurnId: unfinishedTurn }); }}><Icon name="stop" /></button>
              : <button className="send-control" aria-label={activePlan?.stages ? 'Start full plan' : activePlan ? 'Generate plan' : 'Send'} disabled={!connected || sending || !!pending || uploading || !!activePlan?.busy || !!activePlan?.unconfirmed || planInvalid || !draft.trim() || !!selected && !currentDetail || !!modelProblem}><Icon name="send" /></button>}</div>
          </div></form>
        {modelProblem && <p role="alert">{modelProblem}</p>}{pending && <p className="muted">Checking this message’s original delivery. It will not be sent again automatically. <button onClick={async () => { try { const input = await request<ControlApiInput | null>(`inputs/${pending}`); if (input) setNotice(input.error ?? (input.delivery === 'sent' ? 'Message sent' : input.delivery === 'not_sent' ? 'Message was not sent' : 'Delivery remains unconfirmed')); else { const receipt = await request<{state: string; result?: {ok: boolean; error?: string}} | null>(`operations/${pending}`); if (receipt?.state === 'done' && receipt.result?.ok === false) { setError(receipt.result.error ?? 'Message was not admitted'); setPending(null); } else setNotice('Delivery remains unconfirmed.'); } } catch (error) { setError((error as Error).message); } }}>Check delivery</button></p>}
        </div></main>}
  </div>{attachmentPreview && <div className="attachment-preview-backdrop" role="presentation" onClick={() => setAttachmentPreview(null)}><section className="attachment-preview" role="dialog" aria-modal="true" aria-label={`Preview ${attachmentPreview.name}`} onClick={event => event.stopPropagation()}><header><strong>{attachmentPreview.name}</strong><button type="button" aria-label="Close image preview" onClick={() => setAttachmentPreview(null)}>×</button></header><img src={attachmentPreview.src} alt={attachmentPreview.name} /></section></div>}{error && <div className="error" role="alert">{error}</div>}<nav className="mobile-nav"><button aria-label="Tasks" onClick={() => setView('tasks')}><Icon name="tasks" /></button><button aria-label="Chat" onClick={() => setView('chat')}><Icon name="chat" /></button><button aria-label="New chat" onClick={() => select(null)}><Icon name="plus" /></button><button aria-label="Settings" onClick={() => setView('settings')}><Icon name="settings" /></button></nav></div>;
}
function App() {
  useEffect(() => {
    const viewport = window.visualViewport;
    let restingHeight = viewport?.height ?? window.innerHeight;
    const fit = () => {
      const height = viewport?.height ?? window.innerHeight;
      const typing = document.activeElement instanceof HTMLTextAreaElement && !!document.activeElement.closest('.composer');
      if (!typing) restingHeight = Math.max(restingHeight, height);
      document.documentElement.style.setProperty('--remote-viewport-height', `${height}px`);
      document.documentElement.style.setProperty('--remote-viewport-top', `${viewport?.offsetTop ?? 0}px`);
      document.documentElement.dataset.remoteKeyboard = String(typing && restingHeight - height > 120);
    };
    const focusChanged = () => { queueMicrotask(fit); };
    fit(); viewport?.addEventListener('resize', fit); viewport?.addEventListener('scroll', fit); window.addEventListener('resize', fit); document.addEventListener('focusin', focusChanged); document.addEventListener('focusout', focusChanged);
    return () => { viewport?.removeEventListener('resize', fit); viewport?.removeEventListener('scroll', fit); window.removeEventListener('resize', fit); document.removeEventListener('focusin', focusChanged); document.removeEventListener('focusout', focusChanged); };
  }, []);
  const [connected, setConnected] = useState(false);
  const [initialBootstrap, setInitialBootstrap] = useState<RemoteBootstrap | null>(null);
  const [connecting, setConnecting] = useState(hasRemoteLink() || hasRemoteToken()), [error, setError] = useState('');
  const reconnect = async () => {
    setConnecting(true); setError('');
    try { await reconnectRemote(); setInitialBootstrap(await connectRemote()); setConnected(true); }
    catch (cause) { setError((cause as Error).message); }
    finally { setConnecting(false); }
  };
  useEffect(() => {
    if (!hasRemoteLink() && !hasRemoteToken()) return;
    void connectRemote().then(value => { setInitialBootstrap(value); setConnected(true); })
      .catch(error => setError((error as Error).message)).finally(() => setConnecting(false));
  }, []);
  return connected ? <Workspace initialBootstrap={initialBootstrap} disconnect={() => { forgetRemoteLink(); setInitialBootstrap(null); setConnected(false); }} />
    : <main className="pair"><div className="brand">◈ OneCode <small>Remote</small></div><h1>{connecting ? 'Connecting…' : 'Open your remote link'}</h1>
      {!connecting && <><p role={error ? 'alert' : undefined}>{error || 'Copy the link from OneCode Settings → Remote and open it here.'}</p>{error && hasRemoteLink() && <button onClick={() => void reconnect()}>Reconnect</button>}</>}</main>;
}
createRoot(document.getElementById('root')!).render(<App />);
