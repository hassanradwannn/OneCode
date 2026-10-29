import type { ReasoningEffort } from './session.js';
/** GPT-6 Pro is Astra. Compare exact picker names/slugs, never arbitrary substring matches. */
export function isAstraModel(model: string | null | undefined, effort?: ReasoningEffort): boolean {
  const normalized = (model ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return /^(?:astra|(?:gpt-?)?6(?:\.0)?-(?:pro|astra))$/.test(normalized) ||
    (/^(?:gpt-?)?6(?:\.0)?$/.test(normalized) && effort === 'pro');
}
export type NativeModelSurface = 'chat' | 'work';
export type ChatModelAffinity = { provider: import('./chat-provider.js').ChatProvider; model: string; surface: NativeModelSurface };
export type NativeReasoningControl = { kind: 'levels'; label: string } |
  { kind: 'toggle'; label: string; on: ReasoningEffort; off: ReasoningEffort; checked: boolean };
export type ChatModelOption = { id: string; label: string; efforts: ReasoningEffort[]; aliases?: string[]; nativeSurface?: NativeModelSurface;
  /** false means unobserved, distinct from an observed empty effort menu. Legacy adapters omit it. */
  effortsObserved?: boolean; reasoningControl?: NativeReasoningControl; description?: string; group?: string; effortLabels?: Partial<Record<ReasoningEffort, string>>; effortHints?: Partial<Record<ReasoningEffort, string>> };
/** Only positively observed controls render; old adapters retain their existing level picker. */
export function nativeReasoningControl(model: ChatModelOption | undefined, provider?: import('./chat-provider.js').ChatProvider): NativeReasoningControl | null {
  if (!model || model.effortsObserved === false) return null;
  if (model.reasoningControl) return model.reasoningControl;
  return provider !== 'claude' && model.efforts.length ? { kind: 'levels', label: 'Effort' } : null;
}
export type ChatModelDiscoveryRequest = { nonce: string; expiresAt: number; allowOpen: boolean;
  provider: import('./chat-provider.js').ChatProvider; model?: string };
/** Empty intent keeps native settings; it must not invent a provider's Automatic mode. */
export function currentModelChoiceLabel(provider?: import('./chat-provider.js').ChatProvider): string {
  return provider === 'claude' ? 'Current model' : 'Automatic';
}
export function currentEffortChoiceLabel(provider?: import('./chat-provider.js').ChatProvider): string {
  return provider === 'claude' ? 'Current effort' : 'Automatic';
}
/** Native label identifiers are opaque; syntax alone never proves account availability. */
export function isNativeModelId(value: unknown, provider?: import('./chat-provider.js').ChatProvider): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 80 && value.trim() === value &&
    (provider === 'claude' ? !/[\u0000-\u001f\u007f]/.test(value) : /^[A-Za-z0-9._-]+$/.test(value));
}
export const EFFORT_NAMES: Record<string, string> = { none: 'Instant', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra', pro: 'Pro' } satisfies Record<ReasoningEffort, string>;
export const COMPOSER_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'pro'] as const;
/**
 * The Gemini model Goal and Loop decisions run on unless Settings chose another: the GPT-6 family.
 * With the default High effort that is its thinking lane (`gpt-6-thinking`), the lane a decision
 * wants; the family id lets Settings show it as the one "GPT-6" the picker lists (#1217). An account
 * without it falls back to Gemini's current selection (goal.ts).
 */
export const DEFAULT_HELPER_CHAT_MODEL = 'gemini-current';
/** Shipped defaults before this one; a config still holding exactly one adopts the current one (config.ts). */
export const SUPERSEDED_HELPER_CHAT_MODELS: readonly string[] = ['gpt-5.6-sol', 'gpt-6-thinking'];
/** Pro silence policy follows the selected provider identity, including the older generation. */
export function isProModel(model: string | null | undefined, effort?: ReasoningEffort): boolean {
  const normalized = (model ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return effort === 'pro' || isAstraModel(model, effort) || /^(?:pro|(?:gpt-?)?\d+(?:[.-]\d+)?-pro)$/.test(normalized);
}
/**
 * Whether this reasoning effort makes long silences normal.
 *
 * A model above `high` routinely goes minutes without touching the page between tool calls, and
 * the silence watchdog's two-minute window reads that as a dead tab. Pro is excluded here only
 * because it already has its own, wider window; `isProModel` covers it.
 *
 * `high` is deliberately **not** in this list. It is the ordinary effort for the current models —
 * the whole bridge suite uses it as the plain non-Pro case — and widening it would make a
 * genuinely dead page wait ten minutes instead of two. The harm this exists for was measured at
 * Extra high (#393): "An Extra-high turn that thinks longer than that between tool calls".
 *
 * Deliberately not "anything above medium as a number" either: the list is the vocabulary in
 * REASONING_EFFORTS, so a level added there has to be classified here on purpose rather than
 * inheriting a threshold nobody revisited.
 */
export function isDeliberateEffort(effort?: ReasoningEffort | null): boolean {
  return effort === 'xhigh' || effort === 'max' || effort === 'ultra';
}
const normalizeChatModelName = (value: string): string =>
  value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}.]/gu, '');
/**
 * Resolve a saved model value to one observed catalog entry.
 *
 * An exact execution id or lane alias wins. Otherwise a unique display-label match
 * resolves — settings saved before lanes had catalog ids, and labels the picker itself
 * shows (family "6" for gpt-6-pro), must round-trip or every saved default silently
 * falls back. An ambiguous label resolves to nothing: guessing a lane is not a
 * rounding decision.
 */
export function resolveChatModel(models: ChatModelOption[], value: string): ChatModelOption | undefined {
  const exact = models.filter(choice => choice.id === value || choice.aliases?.includes(value));
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  // Labels became full names in 2.1.31 ("6" → "GPT-6", "5.6" → "GPT-5.6"); a value saved under the
  // older label still means the same family, so a leading "GPT" never decides the match.
  const bare = (text: string): string => normalizeChatModelName(text).replace(/^gpt(?=\d)/, '');
  const name = bare(value);
  const matches = name ? models.filter(choice => bare(choice.label) === name) : [];
  return matches.length === 1 ? matches[0] : undefined;
}
/** Keep the selected generation intact; Pro is already a complete model label. */
export function chatModelDisplayLabel(label: string, effort: ReasoningEffort, effortLabel: string): string {
  if (effort === 'pro') return /\bpro$/i.test(label) ? label : `${label.replace(/\s+Sol$/i, '')} Pro`;
  return `${label} · ${effortLabel}`;
}
export type ChatModelCatalog = {
  provider?: import('./chat-provider.js').ChatProvider;
  state: 'unknown' | 'pending' | 'ready' | 'unavailable';
  requestedAt: number | null;
  observedAt: number | null;
  models: ChatModelOption[];
  /** Request progress is not an account observation and never grants Send permission. */
  waiting?: string;
  error?: string;
};
