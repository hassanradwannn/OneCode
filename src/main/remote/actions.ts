import { z } from 'zod';
import { CHAT_PROVIDERS, chatProviderForConversation } from '../../shared/chat-provider.js';
import { REASONING_EFFORTS } from '../../shared/session.js';
import { getSession, renameSession } from '../session/store.js';
import { sendDesktopInput, cancelDesktopInput } from '../session/start-input.js';
import { listInputs } from '../session/input.js';
import { sessionControlsFor, stopSessionTurn } from '../bridge.js';
import { getChatModels, startChatModelDiscovery } from '../chat-models.js';
import { resolveChatModel } from '../../shared/chat-models.js';
import { projectInput } from '../control-reads.js';
import { saveRemotePreferences } from './preferences.js';
import { attachmentSchema } from '../session/input-attachments.js';
import { draftTaskPlan, goalBackendFor } from '../goal.js';
import { runTaskRequest, cancelTaskRequest } from '../task-request.js';

const sessionId = z.string().regex(/^[0-9a-z-]{8,64}$/);
const send = z.object({ action: z.literal('send'), id: z.string().uuid(), sessionId: sessionId.nullable(), provider: z.enum(CHAT_PROVIDERS),
  text: z.string().trim().min(1).max(64_000), model: z.string().max(80).nullable(), reasoningEffort: z.enum(REASONING_EFFORTS).nullable(),
  expectedTurnId: z.string().min(1).max(256).nullable(), afterTurn: z.boolean().optional(), automation: z.enum(['off', 'goal', 'loop']).optional(),
  attachments: z.array(attachmentSchema).max(20).optional(),
  plan: z.array(z.string().trim().min(1).max(16000)).min(1).max(12).refine(stages => JSON.stringify(stages).length <= 12000).optional() }).strict();
export const remoteActionSchema = z.discriminatedUnion('action', [send,
  z.object({ action: z.literal('draftPlan'), id: z.string().uuid(), text: z.string().trim().min(1).max(16000) }).strict(),
  z.object({ action: z.literal('cancelPlan'), id: z.string().uuid(), requestId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('stop'), id: z.string().uuid(), sessionId, expectedTurnId: z.string().min(1).max(256) }).strict(),
  z.object({ action: z.literal('rename'), id: z.string().uuid(), sessionId, title: z.string().trim().min(1).max(120), expectedTitle: z.string().max(120) }).strict(),
  z.object({ action: z.literal('cancel'), id: z.string().uuid(), inputId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('refreshModels'), id: z.string().uuid(), provider: z.enum(CHAT_PROVIDERS) }).strict(),
  z.object({ action: z.literal('preferences'), id: z.string().uuid(), expectedRevision: z.string().regex(/^[0-9a-f]{64}$/), changes: z.unknown() }).strict()
]);
export async function remoteAction(body: z.infer<typeof remoteActionSchema>): Promise<unknown> {
  if (body.action === 'draftPlan') {
    const backend = goalBackendFor('goal') === 'api' ? 'api' : 'chatgpt';
    return runTaskRequest(body.id, JSON.stringify(['plan', body.text, backend]), signal => draftTaskPlan(body.text, backend, undefined, signal), () => undefined);
  }
  if (body.action === 'cancelPlan') return { cancelled: cancelTaskRequest(body.requestId) };
  if (body.action === 'preferences') return saveRemotePreferences({ expectedRevision: body.expectedRevision, changes: body.changes });
  if (body.action === 'refreshModels') return startChatModelDiscovery(true, body.provider);
  if (body.action === 'cancel') return { cancelled: await cancelDesktopInput(body.inputId) };
  const session = body.sessionId ? await getSession(body.sessionId) : null;
  if (body.sessionId && !session?.conversationId) throw new Error('This task has no attached provider chat.');
  if (body.action === 'rename') { await renameSession(body.sessionId, body.title, 'manual', undefined, body.expectedTitle); return { title: body.title }; }
  if (body.action === 'stop') return stopSessionTurn(body.sessionId, body.expectedTurnId);
  const existing = (await listInputs()).find(row => row.id === body.id);
  const text = body.plan?.[0] ?? body.text;
  const objective = body.plan || body.automation === 'goal' ? body.text : undefined;
  if (existing) {
    if (existing.text !== text || existing.objective !== objective || JSON.stringify(existing.stages ?? []) !== JSON.stringify(body.plan?.slice(1) ?? []) || existing.sessionId !== (body.sessionId ?? body.id) || existing.chatProvider !== body.provider || existing.model !== body.model || existing.reasoningEffort !== body.reasoningEffort || existing.automation !== body.automation || JSON.stringify(existing.attachments ?? []) !== JSON.stringify(body.attachments ?? []))
      throw new Error('Message id belongs to a different input.');
    return { input: projectInput(existing) };
  }
  if (session?.conversationId && chatProviderForConversation(session.conversationId) !== body.provider) throw new Error('An existing chat keeps its provider.');
  const activeTurnId = session ? (await sessionControlsFor(session.id)).activeTurnId : null;
  if ((activeTurnId ?? null) !== body.expectedTurnId) throw new Error('Task state changed. Refresh before sending.');
  if (body.model) {
    const model = resolveChatModel(getChatModels(body.provider).models, body.model);
    if (!model || (body.reasoningEffort && !model.efforts.includes(body.reasoningEffort))) throw new Error('Refresh models and choose an available model and thinking effort.');
  } else if (body.reasoningEffort) throw new Error('Select a model before choosing thinking effort.');
  if (body.automation === 'goal' && body.text.length > 16_000) throw new Error('Keep a new Goal objective below 16,000 characters.');
  const input = await sendDesktopInput({ id: body.id, sessionId: body.sessionId, provider: body.provider, text,
    ...(body.automation ? { automation: body.automation } : {}),
    ...(body.plan ? { objective, stages: body.plan.slice(1), authoredSource: 'objective' as const }
      : body.automation === 'goal' ? { objective, authoredSource: 'text' as const } : {}),
    ...(body.attachments?.length ? { attachments: body.attachments } : {}),
    ...(activeTurnId && !body.afterTurn && !body.plan ? { steerTurnId: activeTurnId } : {}), mode: body.plan && activeTurnId ? 'finish' : body.afterTurn ? 'after-turn' : 'auto', dueAt: Date.now(), model: body.model, reasoningEffort: body.reasoningEffort });
  return { input: projectInput(input) };
}
