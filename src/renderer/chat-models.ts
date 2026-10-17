import { ui, uiText, t } from './i18n.js';
import type { ChatModelCatalog } from '../shared/chat-models.js';
import { chatModelDisplayLabel, DEFAULT_HELPER_CHAT_MODEL, resolveChatModel } from '../shared/chat-models.js';
import type { Config } from '../shared/types.js';
import type { ReasoningEffort } from '../shared/session.js';
import { $, el, icon, run } from './dom.js';
import { type ChatProvider } from '../shared/chat-provider.js';
let activeProvider: ChatProvider = 'gemini';
let settingsProvider: ChatProvider = 'gemini';
const catalogs: Partial<Record<ChatProvider, ChatModelCatalog>> = {};

let catalog: ChatModelCatalog = { state: 'unknown', requestedAt: null, observedAt: null, models: [] };
let generation = 0;
let onComposerPaint: (() => void) | undefined;
const catalogWaiters = new Set<() => void>();
let discovery: Promise<void> | null = null;
let catalogSubscribed = false;
type ObservedSelection = { model: string; reasoningEffort?: ReasoningEffort; observedAt: number };
let composerContext: { scope: string | null; observation: ObservedSelection | null; edited: boolean; automatic?: boolean } | null = null;
let ordinaryDefaults: { model: string; reasoningEffort: string } = { model: '', reasoningEffort: '' };
/**
 * Automatic: send with whatever model Gemini already has selected, switching nothing.
 *
 * Send used to wait up to two minutes for the account's model list, and on plans that show no
 * model picker (Gemini Go and Free, #104, #864) that wait always ended in failure. So while no
 * list is readable, a message that asks for no particular model goes out at once, Automatic.
 * Once a list is readable, new chats keep their usual choice (the person's default, or the
 * preferred observed model). Exact requests stay exact: a model the person picked or set as the
 * new-chat default is never replaced by Automatic. The menu also offers Automatic deliberately.
 */
type SendModel = { model: string | null; reasoningEffort: ReasoningEffort | null };
const AUTOMATIC: SendModel = { model: null, reasoningEffort: null };
type ModelInput = { sessionId: string | null; deliveredSessionId?: string | null; conversationId: string | null;
  state: string; purpose?: string; historyAnchored?: boolean; historySeq?: number; messageId?: string;
  model: string | null; reasoningEffort: ReasoningEffort | null };
/** Restore explicit Automatic only from this chat's latest canonical native app Send. */
export function acceptedAutomaticModel(summary: { id: string; conversationId: string | null } | null | undefined,
                                       inputs: readonly ModelInput[]): SendModel | undefined {
  if (!summary?.conversationId || !/^[a-f0-9]{16}$/.test(summary.conversationId)) return undefined;
  const nativeId = new RegExp(`^gemini:${summary.conversationId}:user:[a-f0-9]{16}$`);
  const latest = inputs.filter(row => (row.sessionId ?? row.deliveredSessionId) === summary.id &&
    row.conversationId === summary.conversationId && row.state === 'sent' && (!row.purpose || row.purpose === 'user') &&
    row.historyAnchored === true && Number.isSafeInteger(row.historySeq) && row.historySeq! > 0 && nativeId.test(row.messageId || ''))
    .sort((left, right) => right.historySeq! - left.historySeq!)[0];
  return latest && (latest.model === null || latest.model === 'gemini-current') && latest.reasoningEffort === null ? { ...AUTOMATIC } : undefined;
}
/** Whether this composer asks for one particular model rather than whatever Gemini uses. */
function exactModelRequested(): boolean {
  if (composerContext?.automatic) return false;
  if (composerContext?.edited) return !!$<HTMLSelectElement>('composerModel').value;
  // A new chat asks for the configured default; an existing chat already has its own model.
  return !composerContext || composerContext.scope === null ? !!ordinaryDefaults.model : false;
}
function automaticApplies(): boolean {
  return composerContext?.automatic === true || (!catalog.models.length && !exactModelRequested());
}
/** The person chose Automatic (from the menu, or instead of an unavailable exact model). */
function chooseAutomatic(): void {
  if (composerContext) { composerContext.edited = true; composerContext.automatic = true; }
  else composerContext = { scope: null, observation: null, edited: true, automatic: true };
  paintPair('composerModel', 'composerReasoning', '', '');
  paintStatus();
}
const pairs = [
  ['composerModel', 'composerReasoning', false],
  ['defaultChatModel', 'defaultChatReasoning', true],
  ['workerModel', 'workerReasoning', false],
  ['helperModel', 'helperReasoning', false]
] as const;
const effortNames: Record<string, string> = { none: "Instant", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra", pro: 'Pro' } satisfies Record<ReasoningEffort, string>;
const composerEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'pro'] as const;
const effortLabel = (effort: string): string => effortNames[effort] ? t(effortNames[effort]) : effort;
function observedModel(value: string) {
  return resolveChatModel(catalog.models, value);
}

/**
 * A model and effort as the composer shows them ("GPT-6 Sol · High", "… · Instant"), for any
 * observed choice; a model this account's catalog does not list keeps its id.
 */
export function chatModelName(model: string, reasoningEffort: string | undefined): string {
  const label = observedModel(model)?.label ?? model;
  return reasoningEffort ? chatModelDisplayLabel(label, reasoningEffort as ReasoningEffort, effortLabel(reasoningEffort)) : label;
}

function paintComposerContext(): void {
  if (!composerContext || composerContext.edited) return;
  if (composerContext.scope === null) {
    paintPair('composerModel', 'composerReasoning', ordinaryDefaults.model, ordinaryDefaults.reasoningEffort);
    return;
  }
  const observed = composerContext.observation;
  const match = observed && observedModel(observed.model);
  // An unknown session model must not inherit the previous chat's valid Send choice.
  paintPair('composerModel', 'composerReasoning', match?.id ?? observed?.model ?? 'not-observed',
    observed?.reasoningEffort ?? (match && !match.efforts.length ? '' : 'not-observed'));
}

/** Scope comes from the caller's session + selection generation; no browser mutation.
 * Selection intent comes only from the existing accepted input owner. */
export function applyComposerSessionModel(scope: string | null, observation: ObservedSelection | null, inputSelection?: SendModel, promoting = false): void {
  if (!composerContext || composerContext.scope !== scope) {
    // A later deliberate picker edit belongs to the still-selected New Chat,
    // even if its accepted IPC response arrives after that edit.
    let carried: { model: string; effort: string; automatic: boolean } | null = null;
    if (inputSelection !== undefined && scope !== null) {
      carried = promoting && composerContext?.scope === null && composerContext.edited ? {
        model: $<HTMLSelectElement>('composerModel').value,
        effort: $<HTMLSelectElement>('composerReasoning').value,
        automatic: composerContext.automatic === true || $<HTMLSelectElement>('composerModel').value === 'gemini-current'
      } : { model: inputSelection.model ?? '', effort: inputSelection.reasoningEffort ?? '',
        automatic: inputSelection.model === null || inputSelection.model === 'gemini-current' };
    }
    composerContext = { scope, observation, edited: Boolean(carried), ...(carried ? { automatic: carried.automatic } : {}) };
    if (carried) paintPair('composerModel', 'composerReasoning', carried.automatic ? '' : carried.model, carried.automatic ? '' : carried.effort);
  } else if (observation && (!composerContext.observation || observation.observedAt >= composerContext.observation.observedAt)) {
    composerContext.observation = observation;
  }
  if (inputSelection && scope !== null && !composerContext.edited) {
    composerContext.edited = true;
    composerContext.automatic = inputSelection.model === null || inputSelection.model === 'gemini-current';
    paintPair('composerModel', 'composerReasoning', composerContext.automatic ? '' : inputSelection.model ?? '',
      composerContext.automatic ? '' : inputSelection.reasoningEffort ?? '');
  }
  paintComposerContext(); paintStatus();
}

/** Provider order and available efforts define the slider, including newly released models. */
function composerModels() {
  if (!catalog.models.length) return [];
  return catalog.models
    .filter(model => !model.efforts.length || model.efforts.some(effort => composerEfforts.includes(effort)))
    .map(model => ({ ...model, efforts: composerEfforts.filter(effort => model.efforts.includes(effort)) }));
}

function options(select: HTMLSelectElement, choices: Array<{ id: string; label: string | (() => string) }>, value: string): void {
  const option = (label: string | (() => string), id: string) => {
    const node = el('option', '', label) as HTMLOptionElement; node.value = id; return node;
  };
  const desired = choices.map(choice => option(choice.label, choice.id));
  if (!desired.length && !value) {
    const unavailable = option(() => t("No observed choices"), ''); unavailable.disabled = true; desired.push(unavailable);
  }
  if (value && !choices.some(choice => choice.id === value)) {
    // The worker and helper selects show an Unverified badge beside them; every other select
    // (the composer and the reasoning pickers) keeps saying so in the option itself.
    const badged = select.id === 'workerModel' || select.id === 'helperModel';
    const unverified = option(badged ? value : () => t("{0} · not verified", [value]), value);
    unverified.disabled = true;
    desired.push(unverified);
  }
  // State pushes must not close a native picker or replace nodes while its choices are unchanged.
  if (select.options.length !== desired.length || desired.some((node, index) => {
    const current = select.options[index];
    return !current || current.value !== node.value || current.text !== node.text || current.disabled !== node.disabled;
  })) select.replaceChildren(...desired);
  select.value = value;
  if (select.id === 'workerModel' || select.id === 'helperModel') {
    let badge = select.nextElementSibling as HTMLElement | null;
    if (!badge?.classList.contains('model-verification')) {
      badge = el('span', 'model-verification');
      badge.id = `${select.id}Verification`;
      select.after(badge);
      select.setAttribute('aria-describedby', badge.id);
    }
    const unverified = !!value && !choices.some(choice => choice.id === value);
    badge.hidden = !unverified;
    if (unverified) {
      ui(badge, 'textContent', () => t('Unverified'));
      // Workers and the Goal helper both fall back to Gemini's current model (#499); say so.
      ui(badge, 'title', () => t("This {0} account doesn't offer this model, so its current model is used.", [t("provider")]));
    }
  }
}

function distinctModelChoices(models: ChatModelCatalog['models']): Array<{ id: string; label: string | (() => string) }> {
  const sameName = new Map<string, number>();
  for (const model of models) sameName.set(model.label, (sameName.get(model.label) ?? 0) + 1);
  const variant = (model: ChatModelCatalog['models'][number]): string | null => {
    if (model.efforts.length && model.efforts.every(effort => effort === 'none')) return 'Instant';
    if (model.efforts.length && model.efforts.every(effort => effort !== 'none' && effort !== 'pro')) return 'Reasoning';
    if (model.efforts.length && model.efforts.every(effort => effort === 'pro')) return 'Pro';
    return null;
  };
  const variantCounts = new Map<string, number>();
  for (const model of models) {
    const lane = variant(model);
    if (lane) {
      const key = `${model.label}\0${lane}`;
      variantCounts.set(key, (variantCounts.get(key) ?? 0) + 1);
    }
  }
  return models.map(model => {
    if (sameName.get(model.label) === 1) return { id: model.id, label: model.label };
    const lane = variant(model);
    return { id: model.id, label: lane && variantCounts.get(`${model.label}\0${lane}`) === 1
      ? () => `${model.label} · ${t(lane)}` : `${model.label} · ${model.id}` };
  });
}

function paintPair(modelId: string, effortId: string, modelValue?: string, effortValue?: string, allowEmpty = false): void {
  const model = document.getElementById(modelId) as HTMLSelectElement | null;
  const effort = document.getElementById(effortId) as HTMLSelectElement | null;
  if (!model || !effort) return;
  const models = modelId === 'composerModel' ? composerModels() : (catalogs[settingsProvider] ?? (settingsProvider === activeProvider ? catalog : { models: [] })).models;
  // No saved sub-agent default starts workers on Gemini's current model. The select says so as
  // Automatic instead of naming a model nothing would use; a model picked there still gets its
  // preferred effort.
  const automaticModel = allowEmpty || modelId === 'workerModel';
  let nextModel = modelValue ?? model.value;
  let nextEffort = effortValue ?? effort.value;
  const observed = resolveChatModel(models, nextModel);
  if (modelId !== 'composerModel' && observed?.id !== nextModel && observed?.aliases?.includes(nextModel)) {
    // A saved execution alias is an exact lane request. The family effort union
    // cannot prove which efforts that alias supports. Retain both requested values
    // until the user deliberately selects a family; native selection proves the pair.
    const modelChoices = [...distinctModelChoices(models), { id: nextModel, label: `${observed.label} · ${nextModel}` }];
    if (automaticModel) modelChoices.unshift({ id: '', label: () => t('Automatic') });
    options(model, modelChoices, nextModel);
    const effortChoices = [{ id: nextEffort, label: () => nextEffort ? effortLabel(nextEffort) : t('Keep requested model settings') }];
    if (allowEmpty && nextEffort) effortChoices.unshift({ id: '', label: () => t('Automatic') });
    options(effort, effortChoices, nextEffort);
    return;
  }
  nextModel = observed?.id ?? nextModel;
  if (models.length && !nextModel && !automaticModel && !(modelId === 'composerModel' && composerContext?.automatic)) {
    // A preference selects only a model/effort actually observed in this catalog.
    const preferred = models.find(item => /^gpt[ -]?6$/i.test(item.label) && item.efforts.includes('high'));
    nextModel = (preferred ?? models[0]!).id;
    nextEffort = '';
  }
  const supported = models.find(item => item.id === nextModel)?.efforts;
  if (supported && !nextEffort && !allowEmpty) {
    nextEffort = supported.includes('high') ? 'high' : supported[0] ?? '';
  }
  const modelChoices = distinctModelChoices(models);
  if (automaticModel) modelChoices.unshift({ id: '', label: () => t('Automatic') });
  const effortChoices: Array<{ id: string; label: string | (() => string) }> =
    (models.find(item => item.id === nextModel)?.efforts ?? []).map(id => ({ id, label: () => effortLabel(id) }));
  if (allowEmpty || (automaticModel && !nextModel)) effortChoices.unshift({ id: '', label: () => t('Automatic') });
  options(model, modelChoices, nextModel);
  options(effort, effortChoices, nextEffort);
}

/** The next shortcut action is a projection of the same select Send reads. */
function paintEffortShortcut(supported: readonly ReasoningEffort[]): void {
  const spark = document.getElementById('composerSpark') as HTMLButtonElement | null;
  if (!spark) return;
  const minimum = supported.length > 1 && $<HTMLSelectElement>('composerReasoning').value === supported[0];
  const action = minimum ? 'max' : 'min';
  if (spark.dataset.action !== action) {
    for (const glyph of spark.querySelectorAll<HTMLElement>('.ico')) {
      for (const animation of glyph.getAnimations?.() ?? []) animation.cancel();
    }
  }
  spark.dataset.action = action;
  spark.disabled = supported.length < 2;
  const label = () => spark.disabled ? t('Thinking effort') : minimum
    ? t('Use maximum effort: {0}', [effortLabel(supported.at(-1)!)])
    : t('Use minimum effort: {0}', [effortLabel(supported[0]!)]);
  ui(spark, 'title', label); ui(spark, 'aria-label', label);
}

/** What the open menu shows; the same value means the live slider is kept, not rebuilt. */
function choicesSignature(choices: ReturnType<typeof composerModels>): string {
  return JSON.stringify([catalog.state, choices, $<HTMLSelectElement>('composerModel').value,
    $<HTMLSelectElement>('composerReasoning').value, automaticApplies()]);
}

function paintComposerChoices(): void {
  const models = document.getElementById('composerModelChoices');
  const modelOptions = document.getElementById('composerModelOptions');
  const powers = document.getElementById('composerPowerChoices');
  if (!models || !modelOptions || !powers) return;
  const selected = $<HTMLSelectElement>('composerModel');
  const effort = $<HTMLSelectElement>('composerReasoning');
  const choices = composerModels();
  const signature = choicesSignature(choices);
  if (models.dataset.signature === signature) return;
  models.dataset.signature = signature;
  const supported = choices.find(choice => choice.id === selected.value)?.efforts ?? [];
  paintEffortShortcut(supported);
  modelOptions.replaceChildren();
  powers.replaceChildren();
  const title = document.getElementById('composerPowerTitle');
  const subtitle = document.getElementById('composerPowerModel');
  const toggle = document.getElementById('composerModelToggle') as HTMLButtonElement | null;
  if (toggle) toggle.disabled = !choices.length;
  if (!choices.length) {
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    models.hidden = true;
    models.inert = true;
    if (automaticApplies()) {
      if (title) ui(title, 'textContent', () => t("Automatic"));
      if (subtitle) ui(subtitle, 'textContent', () => t("Sent without choosing a model"));
      return;
    }
    if (title) ui(title, 'textContent', () => catalog.state === 'pending' ? t("Loading models…") : t("Models unavailable"));
    if (subtitle) ui(subtitle, 'textContent', () => catalog.state === 'pending' ? t("Reading your {0} account", [t("provider")]) : t("Reload models"));
    // An exact model was asked for and no list can confirm it. Automatic is offered, never assumed.
    const use = el('button', 'btn', () => t("Use {0}’s current model", [t("provider")])) as HTMLButtonElement;
    use.type = 'button';
    use.dataset.useCurrentModel = '';
    use.addEventListener('click', chooseAutomatic);
    powers.append(use);
    return;
  }
  {
    // Automatic sits first in the list, as a deliberate choice that switches nothing.
    const button = el('button', 'model-choice') as HTMLButtonElement;
    button.type = 'button'; button.dataset.keepMenu = 'true'; button.dataset.model = '';
    const auto = composerContext?.automatic === true;
    button.setAttribute('aria-pressed', String(auto));
    button.append(el('span', '', () => t("Automatic")), icon('i-check'));
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (composerContext?.automatic) return;
      const focused = document.activeElement === button;
      chooseAutomatic();
      if (focused) models.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    });
    modelOptions.append(button);
  }
  for (const choice of distinctModelChoices(choices)) {
    const button = el('button', 'model-choice') as HTMLButtonElement;
    button.type = 'button'; button.dataset.keepMenu = 'true'; button.dataset.model = choice.id;
    button.setAttribute('aria-pressed', String(choice.id === selected.value));
    button.append(el('span', '', choice.label), icon('i-check'));
    button.addEventListener('click', event => {
      // Repainting the choices detaches this button before the document listener.
      // Keep the model menu open without giving it a second selection authority.
      event.stopPropagation();
      if (selected.value === choice.id) return;
      const focused = document.activeElement === button;
      selected.value = choice.id;
      selected.dispatchEvent(new window.Event('change', { bubbles: true }));
      if (focused) models.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    });
    modelOptions.append(button);
  }
  const current = supported.findIndex(power => power === effort.value);
  if (composerContext?.automatic) {
    if (title) ui(title, 'textContent', () => t("Automatic"));
    if (subtitle) ui(subtitle, 'textContent', () => t("Sent without choosing a model"));
    return;
  }
  if (title) ui(title, 'textContent', () => !supported.length && !effort.value
    ? t('Automatic') : current < 0 ? t('Previous selection unavailable') : effortLabel(effort.value));
  const selectedLabel = distinctModelChoices(choices).find(choice => choice.id === selected.value)?.label;
  if (subtitle) ui(subtitle, 'textContent', () => typeof selectedLabel === 'function' ? selectedLabel() : selectedLabel ?? t('Select model'));
  const choose = (power: ReasoningEffort | string): void => {
    if (composerContext) composerContext.edited = true;
    effort.value = power;
    if (title) ui(title, 'textContent', () => power ? effortLabel(power) : t('Automatic'));
    paintComposerLabel();
    paintEffortShortcut(supported);
    models.dataset.signature = choicesSignature(choices);
  };
  if (!supported.length) {
    if (!choices.some(choice => choice.id === selected.value)) {
      // An unknown saved model has no effort to keep. Clearing its stale
      // effort alone leaves Send unconfirmed; choosing current is full-model
      // consent, distinct from keeping an observed model's native effort.
      const use = el('button', 'btn power-single', () => t('Use {0}’s current model', [t("provider")])) as HTMLButtonElement;
      use.type = 'button'; use.dataset.keepMenu = 'true'; use.dataset.useCurrentModel = '';
      use.addEventListener('click', event => { event.stopPropagation(); chooseAutomatic(); });
      powers.append(use);
      return;
    }
    // A native model can be observed without a separate effort catalog. Keeping
    // its current effort is valid; a previously exact effort still needs consent.
    if (selected.value && effort.value) {
      const use = el('button', 'btn power-single', () => t('Automatic')) as HTMLButtonElement;
      use.type = 'button'; use.dataset.keepMenu = 'true';
      use.addEventListener('click', event => { event.stopPropagation(); choose(''); use.remove(); });
      powers.append(use);
    }
    return;
  }
  // One effort (an Instant model) is not a choice: no slider, just its name. A stale saved
  // effort still needs one explicit confirmation before Send may use this model.
  if (supported.length === 1) {
    if (current >= 0) return;
    const only = supported[0]!;
    const use = el('button', 'btn power-single', () => t('Use effort: {0}', [effortLabel(only)])) as HTMLButtonElement;
    use.type = 'button'; use.dataset.keepMenu = 'true';
    use.addEventListener('click', event => { event.stopPropagation(); choose(only); use.remove(); });
    powers.append(use);
    return;
  }
  const last = supported.length - 1;
  const track = el('div', 'power-track');
  // The thumb follows the pointer continuously and settles on the nearest effort when released;
  // keys and the stored choice stay whole steps. The fill ends under the thumb's centre.
  const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = String(last); slider.step = 'any';
  ui(slider, 'aria-label', () => t('Thinking effort'));
  const nearest = (): number => Math.max(0, Math.min(last, Math.round(Number(slider.value))));
  const paintPosition = (value: number): void => { track.style.setProperty('--power-fraction', String(value / last)); };
  const announce = (index: number): void => { ui(slider, 'aria-valuetext', () => effortLabel(supported[index]!)); };
  for (let index = 0; index <= last; index++) {
    const stop = el('span', 'power-stop'); stop.style.setProperty('--power-stop', String(index / last)); track.append(stop);
  }
  let shown = Math.max(0, current);
  slider.value = String(shown);
  paintPosition(shown);
  if (current >= 0) announce(shown);
  else ui(slider, 'aria-valuetext', () => t('Choose an available model and effort'));
  const pick = (index: number): void => {
    announce(index);
    if (index !== shown || effort.value !== supported[index]) { shown = index; choose(supported[index]!); }
  };
  // Test DOMs and hidden windows may lack animation frames; settling then just lands at once.
  const frame = (callback: FrameRequestCallback): number => typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : (callback(performance.now() + 1000), 0);
  const cancelFrame = (id: number): void => { if (id && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id); };
  let settling = 0;
  const settle = (): void => {
    cancelFrame(settling);
    const from = Number(slider.value), to = nearest(), started = performance.now();
    pick(to);
    const step = (now: number): void => {
      const progress = Math.min(1, (now - started) / 140), eased = 1 - (1 - progress) ** 3;
      const value = from + (to - from) * eased;
      slider.value = String(value); paintPosition(value);
      if (progress < 1) settling = frame(step);
    };
    settling = frame(step);
  };
  slider.addEventListener('input', () => { cancelFrame(settling); paintPosition(Number(slider.value)); pick(nearest()); });
  slider.addEventListener('change', settle);
  slider.addEventListener('pointerup', settle);
  slider.addEventListener('keydown', event => {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -1, PageUp: 1, Home: -last, End: last };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    slider.value = String(Math.max(0, Math.min(last, nearest() + move)));
    settle();
  });
  // Keep the range node alive through pointer/keyboard adjustment; hidden selects remain
  // the existing send authority, and no separate model selection state is introduced.
  track.append(slider);
  const endpoints = el('div', 'effort-endpoints');
  endpoints.append(el('span', '', () => effortLabel(supported[0]!)), el('span', '', () => effortLabel(supported[last]!)));
  powers.append(track, endpoints);
}

/** Admission guard for desktop sends: a stale selection is not permission to use defaults. */
/** What Send uses: the confirmed pair, or Automatic (see {@link automaticApplies}). */
export function composerSendModel(): SendModel | null {
  if (composerContext?.automatic) return { ...AUTOMATIC };
  return confirmedComposerModel() ?? (automaticApplies() ? { ...AUTOMATIC } : null);
}

export function confirmedComposerModel(): { model: string; reasoningEffort: ReasoningEffort | null } | null {
  if (!catalog.models.length) return null;
  const model = $<HTMLSelectElement>('composerModel').value;
  const reasoningEffort = $<HTMLSelectElement>('composerReasoning').value;
  const choice = composerModels().find(choice => choice.id === model);
  if (choice && !choice.efforts.length && !reasoningEffort) return { model, reasoningEffort: null };
  const confirmed = choice?.efforts.find(effort => effort === reasoningEffort);
  return confirmed ? { model, reasoningEffort: confirmed } : null;
}

function paintComposerLabel(): void {
  // Display the same admission decision as Send, including discovery and removed efforts.
  const confirmed = confirmedComposerModel();
  const modelLabel = confirmed ? catalog.models.find(model => model.id === confirmed.model)!.label : '';
  const label = () => confirmed
    ? confirmed.reasoningEffort === null ? modelLabel : chatModelDisplayLabel(modelLabel, confirmed.reasoningEffort, effortLabel(confirmed.reasoningEffort))
    : automaticApplies() ? t("Automatic")
    : catalog.state === 'pending' ? t("Loading models…") : t("Select model");
  const node = $('composerModelLabel');
  if (confirmed) {
    const pro = confirmed.reasoningEffort === 'pro';
    node.replaceChildren(el('strong', '', pro ? label : modelLabel));
    if (!pro && confirmed.reasoningEffort !== null) node.append(uiText(() => ` · ${effortLabel(confirmed.reasoningEffort!)}`));
  } else node.replaceChildren(uiText(label));
  ui(node, 'title', label);
  onComposerPaint?.();
}

function paintStatus(): void {
  for (const id of ['composerModelToggle', 'composerModel']) {
    const node = document.getElementById(id);
    if (node) ui(node, 'aria-label', () => t('{0} model', [t("provider")]));
  }
  paintComposerChoices();
  const error = () => catalog.error?.startsWith('Model discovery timed out. ')
    ? t('Model discovery timed out. {0}', [t(catalog.error.slice('Model discovery timed out. '.length))]) : t(catalog.error ?? '');
  const message = () => catalog.state === 'pending' ? t(catalog.waiting ?? "Reading your account’s model choices…")
    : catalog.error ? (catalog.models.length ? t('Refresh failed. Previously observed choices remain available. {0}', [error()]) : error())
    : catalog.state === 'ready' ? t("Available in your {0} account · checked {1}", [t("provider"), new Date(catalog.observedAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })])
    : t("Connect to {0} to load your models.", [t("provider")]);
  for (const id of ['chatModelStatus', 'composerModelStatus']) {
    const node = document.getElementById(id);
    if (node) {
      ui(node, 'textContent', message);
      if (id === 'composerModelStatus') node.hidden = catalog.state === 'ready' && !catalog.error;
    }
  }
  for (const id of ['refreshChatModels', 'refreshComposerModels']) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) {
      // Refresh can promote passive discovery; main coalesces repeated explicit clicks.
      button.disabled = false;
      if (id === 'refreshComposerModels') {
        button.hidden = false;
        ui(button, 'title', () => catalog.state === 'pending' ? t("Reading {0} models", [t("provider")]) : t("Reload {0} models", [t("provider")]));
        ui(button, 'aria-label', () => catalog.state === 'pending' ? t('Reading {0} models', [t("provider")]) : t('Reload {0} models', [t("provider")]));
      }
    }
  }
  paintComposerLabel();
  for (const waiter of catalogWaiters) waiter();
}

/** Refresh and Send share one request; state pushes complete waiting sends without polling. */
function discoverModels(): Promise<void> {
  if (discovery) return discovery;
  const requested = ++generation;
  catalog = { ...catalog, state: 'pending', requestedAt: Date.now(), error: undefined };
  paintStatus();
  const work = (async () => {
    const result = await run(window.api.requestChatModels(activeProvider)).catch(() => null);
    if (requested !== generation) return;
    catalog = result ?? { ...catalog, state: 'unavailable', error: t("Model discovery could not start.") };
    catalogs[activeProvider] = catalog;
    for (const [modelId, effortId, allowEmpty] of pairs) paintPair(modelId, effortId, undefined, undefined, allowEmpty);
    paintComposerContext(); paintStatus();
  })();
  discovery = work.finally(() => { discovery = null; });
  return discovery;
}

export async function ensureComposerModel(refresh = false): Promise<SendModel | null> {
  // Automatic never waits for the list; only an exact request does.
  if (!refresh && automaticApplies()) return composerSendModel();
  if (!refresh && catalog.models.length && catalog.state !== 'pending') return confirmedComposerModel();
  const ready = new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); catalogWaiters.delete(check); resolve(); };
    const check = () => { if (catalog.state === 'ready' || catalog.state === 'unavailable') finish(); };
    const timer = setTimeout(finish, 125000);
    catalogWaiters.add(check);
  });
  await discoverModels();
  await ready;
  // A refresh that failed confirms nothing, even with older choices still on screen.
  return catalog.state === 'ready' && !catalog.error ? composerSendModel() : automaticApplies() ? { ...AUTOMATIC } : null;
}

export function applyChatModels(config: Config, previous?: Config, provider: ChatProvider = config.ui?.chatProvider ?? 'gemini'): void {
  settingsProvider = config.ui?.chatProvider ?? 'gemini';
  const providerChanged = provider !== activeProvider;
  activeProvider = provider;
  if (providerChanged) { catalog = catalogs[provider] ?? { state: 'unknown', requestedAt: null, observedAt: null, models: [] }; ++generation; }
  // Preserve configured values even before an observation arrives; unrelated saves must not erase them.
  const chosen = (id: string, value: string, prior?: string) => {
    const select = document.getElementById(id) as HTMLSelectElement | null;
    return select && document.activeElement === select && previous && select.value !== (prior ?? '') ? select.value : value;
  };
  ordinaryDefaults = { model: config.ui?.defaultChatModel ?? '', reasoningEffort: config.ui?.defaultChatReasoning ?? '' };
  paintPair('defaultChatModel', 'defaultChatReasoning', chosen('defaultChatModel', ordinaryDefaults.model, previous?.ui?.defaultChatModel), chosen('defaultChatReasoning', ordinaryDefaults.reasoningEffort, previous?.ui?.defaultChatReasoning), true);
  paintPair('workerModel', 'workerReasoning', chosen('workerModel', config.multiAgent.defaultModel ?? '', previous?.multiAgent.defaultModel), chosen('workerReasoning', config.multiAgent.defaultReasoning ?? '', previous?.multiAgent.defaultReasoning));
  paintPair('helperModel', 'helperReasoning', chosen('helperModel', config.goal.helperModel ?? DEFAULT_HELPER_CHAT_MODEL, previous?.goal.helperModel ?? DEFAULT_HELPER_CHAT_MODEL), chosen('helperReasoning', config.goal.helperReasoning ?? 'high', previous?.goal.helperReasoning ?? 'high'));
  paintComposerContext();
  if (catalogSubscribed && catalog.state !== 'unknown' && !providerChanged) return;
  const requested = ++generation;
  void window.api.getChatModels(provider).then(result => {
    if (requested !== generation || !result?.ok || !result.data) return;
    catalog = result.data; catalogs[provider] = result.data;
    for (const [modelId, effortId, allowEmpty] of pairs) paintPair(modelId, effortId, undefined, undefined, allowEmpty);
    paintComposerContext();
    paintStatus();
  });
}

export function initChatModels(onPaint?: () => void): void {
  onComposerPaint = onPaint;
  if (window.api.onChatModelsChanged) {
    catalogSubscribed = true;
    window.api.onChatModelsChanged(value => {
      // A current push supersedes every older startup/read/refresh response.
      const provider = value.provider ?? activeProvider; catalogs[provider] = value;
      if (provider !== activeProvider) return;
      ++generation; catalog = value;
      for (const [modelId, effortId, allowEmpty] of pairs) paintPair(modelId, effortId, undefined, undefined, allowEmpty);
      paintComposerContext(); paintStatus();
    });
  }
  const modelMenu = document.getElementById('modelMenu') as HTMLDetailsElement | null;
  const modelToggle = document.getElementById('composerModelToggle') as HTMLButtonElement | null;
  const modelChoices = document.getElementById('composerModelChoices');
  const closeModelChoices = (): void => {
    modelToggle?.setAttribute('aria-expanded', 'false');
    if (modelChoices) { modelChoices.hidden = true; modelChoices.inert = true; }
  };
  modelToggle?.addEventListener('click', () => {
    if (!modelChoices) return;
    const open = modelChoices.hidden;
    modelToggle.setAttribute('aria-expanded', String(open));
    modelChoices.hidden = !open;
    modelChoices.inert = !open;
    if (open) modelChoices.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
  });
  document.getElementById('composerSpark')?.addEventListener('click', event => {
    const spark = event.currentTarget as HTMLElement;
    const effort = $<HTMLSelectElement>('composerReasoning');
    const supported = composerModels().find(model => model.id === $<HTMLSelectElement>('composerModel').value)?.efforts ?? [];
    if (supported.length < 2) return;
    const minimum = effort.value === supported[0];
    const outgoing = spark.querySelector<HTMLElement>(minimum ? '.spark-brain' : '.spark-lightning');
    const incoming = spark.querySelector<HTMLElement>(minimum ? '.spark-lightning' : '.spark-brain');
    const glyphs = [...spark.querySelectorAll<HTMLElement>('.ico')];
    for (const glyph of glyphs) for (const animation of glyph.getAnimations()) animation.cancel();
    // Change the existing selection synchronously; animation never commits or restores it.
    effort.value = minimum ? supported.at(-1)! : supported[0]!;
    effort.dispatchEvent(new window.Event('change', { bubbles: true }));
    if (!outgoing || !incoming) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    outgoing.animate(reduced ? [{ opacity: 1 }, { opacity: 0 }] : [
      { opacity: 1, transform: 'scale(1) rotate(0deg)' }, { opacity: 0, transform: 'scale(.65) rotate(-18deg)' }
    ], { duration: 150, easing: 'ease-out' });
    incoming.animate(reduced ? [{ opacity: 0 }, { opacity: 1 }] : [
      { opacity: 0, transform: 'scale(.65) rotate(18deg)' }, { opacity: 1, transform: 'scale(1) rotate(0deg)' }
    ], { duration: 200, easing: 'cubic-bezier(.16, 1, .3, 1)' });
  });
  modelMenu?.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    if (modelChoices && !modelChoices.hidden) { closeModelChoices(); modelToggle?.focus(); }
    else { modelMenu.open = false; modelMenu.querySelector('summary')?.focus(); }
  });
  modelMenu?.addEventListener('toggle', () => {
    if (!modelMenu.open) closeModelChoices();
    else if (!catalog.models.length) $('refreshComposerModels').click();
  });
  for (const [modelId, effortId, allowEmpty] of pairs) {
    document.getElementById(modelId)?.addEventListener('change', () => {
      if (modelId === 'composerModel' && composerContext) {
        composerContext.edited = true;
        if ($<HTMLSelectElement>(modelId).value) composerContext.automatic = false;
      }
      const model = $<HTMLSelectElement>(modelId);
      const effort = $<HTMLSelectElement>(effortId);
      const supported = catalog.models.find(item => item.id === model.value)?.efforts ?? [];
      const nextEffort = allowEmpty
        ? supported.includes(effort.value as ReasoningEffort) ? effort.value : ''
        : model.value ? supported.includes('high') ? 'high' : supported[0] ?? '' : '';
      paintPair(modelId, effortId, model.value, nextEffort, allowEmpty);
      paintStatus();
    });
    document.getElementById(effortId)?.addEventListener('change', () => {
      if (effortId === 'composerReasoning' && composerContext) composerContext.edited = true;
      paintStatus();
    });
  }
  for (const id of ['refreshChatModels', 'refreshComposerModels']) document.getElementById(id)?.addEventListener('click', () => { void discoverModels(); });
  for (const [modelId, effortId, allowEmpty] of pairs) paintPair(modelId, effortId, undefined, undefined, allowEmpty);
  paintStatus();
}
