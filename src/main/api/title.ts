/** Topic naming is a bounded, tool-free metadata request, independent of task execution. */
import { getSession, renameSession } from '../session/store.js';
import { notifyChanged } from '../session/recorder.js';
import { userPromptText } from '../../shared/user-prompt.js';
import type { ApiProvider } from './providers.js';
import type { ApiModel } from './types.js';

const pending = new Set<Promise<void>>();
const controllers = new Set<AbortController>();
export function generateApiTopicTitle(sessionId: string, conversationId: string, prompt: string, answer: string,
  provider: ApiProvider, model: ApiModel): void {
  const controller = new AbortController(); controllers.add(controller);
  const work = (async () => {
    const question = userPromptText(prompt) ?? prompt;
    const effort = (['minimal', 'low', 'medium', 'high', 'xhigh'] as const).find(value => model.reasoningEfforts?.includes(value));
    const response = await provider.complete({ model: model.id, sessionId: conversationId,
      messages: [{ role: 'system', content: 'OneCode topic naming: return only a short, specific chat topic title (3–7 words) in the user’s language. Name the subject, not the first sentence. No tools, explanation, quotes or headings.' },
        { role: 'user', content: question.slice(0, 2400) + '\n\nAnswer excerpt:\n' + answer.slice(0, 700) }],
      tools: [], stream: false, maxCompletionTokens: Math.min(model.maxCompletionTokens ?? 2048, model.reasoningMandatory ? 2048 : 256),
      ...(model.reasoningMandatory ? (effort ? { reasoningEffort: effort } : {})
        : model.supportedParameters.some(param => param === 'reasoning' || param === 'reasoning_effort') ? { reasoningEnabled: false } : {}),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
    if (response.finishReason === 'length') return;
    const title = response.content.trim().replace(/^['"]|['"]$/g, '').replace(/^title:\s*/i, '').trim();
    if (!title || title.length > 80 || /[\r\n\u0000-\u001f`]/.test(title) || controller.signal.aborted) return;
    const session = await getSession(sessionId);
    if (session?.conversationId !== conversationId || session.titleSource === 'manual' || session.titleSource === 'provider' ||
        session.origin && session.origin.kind !== 'desktop') return;
    await renameSession(sessionId, title, 'provider', conversationId);
    notifyChanged(sessionId);
  })().catch(() => { /* Preserve the fallback and do not replay an uncertain metadata request. */ });
  pending.add(work);
  void work.finally(() => { pending.delete(work); controllers.delete(controller); });
}
export function stopApiTitles(): void { for (const controller of controllers) controller.abort(); }
export async function flushApiTitles(): Promise<void> { await Promise.allSettled([...pending]); }
