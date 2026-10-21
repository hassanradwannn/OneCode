import { z } from 'zod';
import { currentCaller } from './call-context.js';
import { mcpProvider } from './provider-context.js';
import { guard, ok, fail, type SurfaceRegistrar } from './kernel.js';
import { getConfig } from '../config.js';
import { getSession } from '../session/store.js';
import { chatProviderForStoredConversation } from '../../shared/chat-provider.js';
import { chatScheduler } from '../chat-schedules.js';

export function registerAutomationsTool(reg: SurfaceRegistrar): void {
  reg.register('automations', {
    title: 'Scheduled OneCode checks',
    description: 'Create/list/update/cancel durable repeating messages in this exact chat, for hourly completion checks, cron jobs and requested follow-ups. Works with ChatGPT and Gemini. Use create with a stable key, title, message and interval_minutes (1–525600); the app sends the saved message each interval until cancelled. Never claim a provider Monitoring card is a registered OneCode job. Verify the returned id/next_run_at. OneCode must remain running with the PC awake and provider signed in. Each run retains normal MCP permissions. A queued or sent message is not proof a check executed or succeeded. Inspect errors and actual outputs. Only create schedules explicitly requested by the user. list shows current-chat jobs, run receipts and failures. cancel prevents future messages and withdraws its pending unsent input when possible. No automatic replay of an ambiguous Send.',
    inputSchema: z.object({ action: z.enum(['create', 'list', 'update', 'cancel']),
      id: z.string().uuid().optional(), key: z.string().trim().min(1).max(100).optional(),
      title: z.string().trim().min(1).max(160).optional(), message: z.string().trim().min(1).max(16000).optional(),
      interval_minutes: z.number().int().min(1).max(525600).optional(), enabled: z.boolean().optional() }).strict().pipe(z.discriminatedUnion('action', [
      z.object({ action: z.literal('list') }).strict(),
      z.object({ action: z.literal('create'), key: z.string().min(1).max(100), title: z.string().min(1).max(160),
        message: z.string().min(1).max(16000), interval_minutes: z.number().int().min(1).max(525600) }).strict(),
      z.object({ action: z.literal('update'), id: z.string().uuid(), title: z.string().min(1).max(160).optional(),
        message: z.string().min(1).max(16000).optional(), interval_minutes: z.number().int().min(1).max(525600).optional(), enabled: z.boolean().optional() }).strict(),
      z.object({ action: z.literal('cancel'), id: z.string().uuid() }).strict()
    ])),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, input => guard('automations', () => reg.guarded('read', 'automations', async () => {
    const caller = currentCaller(), provider = mcpProvider();
    const session = caller.sessionId ? await getSession(caller.sessionId) : null;
    if (!session?.conversationId || caller.conversationId !== session.conversationId ||
        chatProviderForStoredConversation(session.conversationId) !== provider || session.origin?.kind === 'worker' || session.origin?.kind === 'helper')
      return fail('SCHEDULE_CHAT_UNIDENTIFIED: Exact current chat identity is required. No schedule was created. Use this chat’s app-supplied connection; never guess an id.');
    const owner = { sessionId: session.id, provider };
    const view = (row: Awaited<ReturnType<typeof chatScheduler.create>>) => ({ ...row, runs: row.runs.map(({ text: _wire, ...receipt }) => receipt),
      next_run_at: new Date(row.nextRunAt).toISOString(), requires: 'PC awake, OneCode running, provider signed in; existing local permissions apply.' });
    if (input.action === 'list') return ok(JSON.stringify((await chatScheduler.list(owner)).map(view)));
    if (input.action === 'cancel') return ok(JSON.stringify(view(await chatScheduler.change(input.id, { enabled: false }, owner))));
    if (reg.ctx.readOnly || getConfig().readOnly) return fail('Read-only mode prevents creating or changing schedules. Existing schedules can still be listed or cancelled.');
    if (input.action === 'create') return ok(JSON.stringify(view(await chatScheduler.create(owner, {
      key: input.key, title: input.title, message: input.message, intervalMinutes: input.interval_minutes }))));
    return ok(JSON.stringify(view(await chatScheduler.change(input.id, {
      ...(input.title !== undefined ? { title: input.title } : {}), ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.interval_minutes !== undefined ? { intervalMinutes: input.interval_minutes } : {}), ...(input.enabled !== undefined ? { enabled: input.enabled } : {}) }, owner))));
  })));
}
