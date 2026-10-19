import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getConfig, updateConfig } from '../config.js';
import { REMOTE_UI_KEYS, type RemotePreferences } from '../../shared/remote.js';
import { setChatModelProvider, getChatModels } from '../chat-models.js';
import { CHAT_PROVIDERS, DEFAULT_CHAT_PROVIDER } from '../../shared/chat-provider.js';
import { REASONING_EFFORTS } from '../../shared/session.js';
import { resolveChatModel } from '../../shared/chat-models.js';

export const remotePreferencesSchema = z.object({
  chatProvider: z.enum(CHAT_PROVIDERS).optional(), defaultChatModel: z.string().max(80).optional(),
  defaultChatReasoning: z.union([z.enum(REASONING_EFFORTS), z.literal('')]).optional(), followUp: z.enum(['steer', 'queue']).optional(),
  enterSends: z.boolean().optional(), followOutput: z.boolean().optional(), theme: z.enum(['light', 'dark']).optional(),
  turnNotifications: z.boolean().optional(), backgroundChats: z.boolean().optional(), backgroundPlacement: z.enum(['window', 'group']).optional(),
  tabsToKeepOpen: z.number().int().min(1).max(50).optional(), autoContinue: z.boolean().optional(), autoSelectSkills: z.boolean().optional(), rotateTurnMinutes: z.number().int().min(0).max(120).optional()
}).strict();
const listeners = new Set<() => void>();
export function onRemotePreferencesChange(listener: () => void): void { listeners.add(listener); }
export function remotePreferences(): { preferences: RemotePreferences; preferencesRevision: string } {
  const ui = getConfig().ui;
  const preferences = Object.fromEntries(REMOTE_UI_KEYS.map(key => [key, ui[key]])) as RemotePreferences;
  return { preferences, preferencesRevision: revision(preferences) };
}
function revision(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export async function saveRemotePreferences(raw: unknown): Promise<ReturnType<typeof remotePreferences>> {
  const { expectedRevision, changes } = z.object({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), changes: remotePreferencesSchema }).strict().parse(raw);
  await updateConfig(current => {
    if (remotePreferences().preferencesRevision !== expectedRevision) throw new Error('Preferences changed. Reload them before saving.');
    const providerChanged = changes.chatProvider !== undefined && changes.chatProvider !== current.ui.chatProvider;
    const ui = { ...current.ui, ...changes, ...(changes.defaultChatModel === '' || providerChanged && !changes.defaultChatModel ? { defaultChatModel: undefined } : {}),
      defaultChatReasoning: changes.defaultChatReasoning === '' || providerChanged && changes.defaultChatReasoning === undefined ? undefined : changes.defaultChatReasoning ?? current.ui.defaultChatReasoning };
    if (ui.defaultChatModel && (providerChanged || 'defaultChatModel' in changes || 'defaultChatReasoning' in changes)) {
      const model = resolveChatModel(getChatModels(ui.chatProvider ?? DEFAULT_CHAT_PROVIDER).models, ui.defaultChatModel);
      if (!model || (ui.defaultChatReasoning && !model.efforts.includes(ui.defaultChatReasoning))) throw new Error('Refresh models and choose an available model and thinking effort.');
    }
    return { ...current, ui };
  });
  await setChatModelProvider(getConfig().ui.chatProvider ?? DEFAULT_CHAT_PROVIDER);
  for (const listener of listeners) listener();
  return remotePreferences();
}
