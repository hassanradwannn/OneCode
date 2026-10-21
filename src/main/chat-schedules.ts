/** Durable interval messages. The existing outbox is the sole Send/ACK authority. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CHAT_PROVIDERS, chatProviderForStoredConversation } from '../shared/chat-provider.js';
import type { ChatSchedule, ChatScheduleRun } from '../shared/chat-schedules.js';
import type { SessionSummary } from '../shared/session.js';
import { durableRevision, readDurable, writeDurableNow } from './durable.js';
import { getConfig } from './config.js';
import { getSession } from './session/store.js';
import { listInputs, type InputArgs, type InputEntry } from './session/input.js';
import { sendDesktopInput, cancelDesktopInput } from './session/start-input.js';
import { conversationAccessRefusal } from './session/conversation-access.js';
import { logWarn } from './logger.js';

const STATE = 'chat-schedules';
const runSchema = z.object({ inputId: z.string().uuid(), dueAt: z.number().int().nonnegative(), text: z.string().min(1).max(18000),
  state: z.enum(['reserved', 'queued', 'sent', 'failed', 'cancelled']), detail: z.string().max(1000).optional() }).strict();
const scheduleSchema = z.object({ id: z.string().uuid(), key: z.string().min(1).max(100), sessionId: z.string().min(8).max(64),
  provider: z.enum(CHAT_PROVIDERS), title: z.string().min(1).max(160), message: z.string().min(1).max(16000),
  intervalMinutes: z.number().int().min(1).max(525600), enabled: z.boolean(), createdAt: z.number().int().nonnegative(),
  nextRunAt: z.number().int().nonnegative(), lastError: z.string().max(1000).optional(), runs: z.array(runSchema).max(20) }).strict();
const stateSchema = z.array(scheduleSchema).max(200);
type Owner = Pick<ChatSchedule, 'sessionId' | 'provider'>;
type Create = Pick<ChatSchedule, 'key' | 'title' | 'message' | 'intervalMinutes'>;
export interface ChatScheduleDeps {
  now(): number;
  revision?(): number;
  load(): Promise<unknown>;
  save(rows: ChatSchedule[]): Promise<void>;
  session(id: string): Promise<SessionSummary | null>;
  inputs(): Promise<InputEntry[]>;
  send(args: InputArgs, scheduleId: string): Promise<InputEntry>;
  cancel(inputId: string): Promise<boolean>;
  refusal(session: SessionSummary): Promise<string | null>;
}

export class ChatScheduler {
  private rows: ChatSchedule[] | null = null;
  private loadedRevision = -1;
  private stopped = false;
  private tail: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly deps: ChatScheduleDeps) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work); this.tail = next.catch(() => undefined); return next;
  }
  private async load(): Promise<ChatSchedule[]> {
    if (this.deps.revision && this.loadedRevision !== this.deps.revision()) this.rows = null;
    if (!this.rows) {
      const saved = await this.deps.load();
      const parsed = saved == null ? [] : stateSchema.parse(saved);
      if (new Set(parsed.map(row => row.id)).size !== parsed.length ||
          new Set(parsed.map(row => `${row.sessionId}\0${row.key}`)).size !== parsed.length)
        throw new Error('Invalid duplicate schedule ownership');
      this.rows = parsed; this.loadedRevision = this.deps.revision?.() ?? -1;
    }
    return this.rows;
  }
  private async commit(rows: ChatSchedule[]): Promise<void> {
    stateSchema.parse(rows); await this.deps.save(rows); this.rows = rows; this.loadedRevision = this.deps.revision?.() ?? -1;
  }
  private async owner(owner: Owner): Promise<SessionSummary> {
    const session = await this.deps.session(owner.sessionId);
    if (!session?.conversationId || chatProviderForStoredConversation(session.conversationId) !== owner.provider ||
        session.origin?.kind === 'worker' || session.origin?.kind === 'helper') throw new Error('Schedule chat is unavailable');
    return session;
  }
  list(owner?: Owner): Promise<ChatSchedule[]> {
    return this.serial(async () => structuredClone((await this.load()).filter(row => !owner ||
      row.sessionId === owner.sessionId && row.provider === owner.provider)));
  }
  create(owner: Owner, input: Create): Promise<ChatSchedule> {
    return this.serial(async () => {
      await this.owner(owner);
      const rows = await this.load();
      const existing = rows.find(row => row.sessionId === owner.sessionId && row.key === input.key);
      if (existing) {
        if (existing.provider !== owner.provider || existing.message !== input.message || existing.intervalMinutes !== input.intervalMinutes)
          throw new Error('This schedule key already exists with different settings; update its returned id');
        return structuredClone(existing);
      }
      if (rows.length >= 200 || rows.filter(row => row.sessionId === owner.sessionId && row.enabled).length >= 20)
        throw new Error('Schedule limit reached; cancel or update an existing schedule');
      const now = this.deps.now();
      const row = scheduleSchema.parse({ ...owner, ...input, id: randomUUID(), enabled: true, createdAt: now,
        nextRunAt: now + input.intervalMinutes * 60000, runs: [] });
      await this.commit([...rows, row]); return structuredClone(row);
    });
  }
  change(id: string, patch: Partial<Pick<ChatSchedule, 'message' | 'title' | 'intervalMinutes' | 'enabled'>>, owner?: Owner): Promise<ChatSchedule> {
    return this.serial(async () => {
      const rows = await this.load(), row = rows.find(candidate => candidate.id === id && (!owner ||
        candidate.sessionId === owner.sessionId && candidate.provider === owner.provider));
      if (!row) throw new Error('Schedule not found in this chat');
      if (patch.enabled === true) await this.owner(row);
      const next = scheduleSchema.parse({ ...row, ...patch, lastError: undefined,
        ...((patch.intervalMinutes !== undefined || patch.enabled === true) ? { nextRunAt: this.deps.now() + (patch.intervalMinutes ?? row.intervalMinutes) * 60000 } : {}) });
      // Withdraw future authority first. Cancellation then uses the original outbox owner.
      await this.commit(rows.map(candidate => candidate === row ? next : candidate));
      if (patch.enabled === false) {
        const run = next.runs.at(-1);
        if (run && ['reserved', 'queued'].includes(run.state)) await this.deps.cancel(run.inputId);
      }
      return structuredClone(next);
    });
  }
  tick(): Promise<void> {
    return this.serial(async () => {
      if (this.stopped) return;
      const rows = await this.load();
      for (const saved of [...rows]) {
        let row = (await this.load()).find(candidate => candidate.id === saved.id)!;
        const inputs = await this.deps.inputs();
        let run = row.runs.at(-1);
        if (run && ['reserved', 'queued'].includes(run.state)) {
          const input = inputs.find(input => input.id === run!.inputId);
          if (!row.enabled && (!input || !['sent', 'failed', 'cancelled'].includes(input.state))) {
            // A crash may separate durable cancellation from outbox withdrawal.
            // Retry only that cancellation, never its original Send.
            try {
              await this.deps.cancel(run.inputId);
              if (!input) await this.commit((await this.load()).map(candidate => candidate.id === row.id
                ? { ...row, lastError: undefined, runs: [...row.runs.slice(0, -1), { ...run!, state: 'cancelled' as const }] } : candidate));
            } catch (error) { await this.setError(row, `Pending scheduled message withdrawal failed: ${(error as Error).message}`); }
            continue;
          }
          if (input) {
            const state = input.state === 'sent' ? 'sent' : input.state === 'failed' ? 'failed' : input.state === 'cancelled' ? 'cancelled' : 'queued';
            const detail = input.error?.slice(0, 1000);
            if (run.state !== state || run.detail !== detail) {
              run = { ...run, state, ...(detail ? { detail } : { detail: undefined }) };
              row = { ...row, lastError: undefined, runs: [...row.runs.slice(0, -1), run] };
              await this.commit((await this.load()).map(candidate => candidate.id === row.id ? row : candidate));
            }
            // One unresolved original input. Never replay an ambiguous native Send or build a backlog.
            if (state === 'queued') continue;
          } else if (run.state === 'queued') {
            row = { ...row, lastError: 'The scheduled message is missing from the outbox. It was not replayed.',
              runs: [...row.runs.slice(0, -1), { ...run, state: 'failed', detail: 'Outbox receipt unavailable; no automatic replay.' }] };
            await this.commit((await this.load()).map(candidate => candidate.id === row.id ? row : candidate));
            continue;
          }
        }
        if (!row.enabled || this.stopped) continue;
        const reserved = row.runs.at(-1)?.state === 'reserved' ? row.runs.at(-1)! : null;
        if (!reserved && row.nextRunAt > this.deps.now()) continue;
        let session: SessionSummary;
        try { session = await this.owner(row); }
        catch { await this.setError(row, 'The scheduled chat is unavailable. No message was sent.'); continue; }
        const refusal = await this.deps.refusal(session);
        if (refusal) { await this.setError(row, refusal); continue; }
        // Persist one exact input id before admission. Crash recovery retries admission of
        // that same id; the durable outbox decides whether it was already accepted/sent.
        const currentRun: ChatScheduleRun = reserved ?? { inputId: randomUUID(), dueAt: row.nextRunAt, state: 'reserved',
          text: `[OneCode scheduled check: ${row.title}]\n${row.message}\n\nThis is the user's saved recurring check. Inspect actual current results with OneCode tools. Report failures; do not assume completion. The schedule continues until cancelled.` };
        if (!reserved) {
          const period = row.intervalMinutes * 60000;
          const nextRunAt = row.nextRunAt + (Math.floor(Math.max(0, this.deps.now() - row.nextRunAt) / period) + 1) * period;
          row = { ...row, nextRunAt, lastError: undefined, runs: [...row.runs, currentRun].slice(-20) };
          await this.commit((await this.load()).map(candidate => candidate.id === row.id ? row : candidate));
        }
        try {
          // Recheck the same session around policy I/O; no settings-selected provider or active tab supplies identity.
          const latest = await this.owner(row);
          if (latest.conversationId !== session.conversationId) continue;
          if (this.stopped) return;
          await this.deps.send({ id: currentRun.inputId, sessionId: row.sessionId, provider: row.provider,
            text: currentRun.text,
            mode: 'after-turn', dueAt: currentRun.dueAt, model: null, reasoningEffort: null, authoredSource: 'none' }, row.id);
          const next = { ...row, lastError: undefined, runs: [...row.runs.slice(0, -1), { ...currentRun, state: 'queued' as const }] };
          await this.commit((await this.load()).map(candidate => candidate.id === row.id ? next : candidate));
        } catch (error) {
          // Admission failure may follow a durable write: retain the reserved id, never invent a replacement.
          await this.setError(row, `Scheduled message admission failed: ${(error as Error).message}`);
        }
      }
    });
  }
  private async setError(row: ChatSchedule, error: string): Promise<void> {
    const message = error.slice(0, 1000);
    if (row.lastError === message) return;
    await this.commit((await this.load()).map(candidate => candidate.id === row.id ? { ...row, lastError: message } : candidate));
  }
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const run = () => { void this.tick().catch(error => logWarn(`scheduled checks: ${(error as Error).message}`)); };
    this.timer = setInterval(run, 5000); this.timer.unref(); run();
  }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; await this.tail; }
}

export const chatScheduler = new ChatScheduler({ now: () => Date.now(), revision: () => durableRevision(STATE),
  load: () => readDurable(STATE, { strict: true }), save: rows => writeDurableNow(STATE, rows),
  session: getSession, inputs: listInputs, send: sendDesktopInput, cancel: cancelDesktopInput,
  refusal: async session => getConfig().readOnly ? 'Scheduled messages are waiting while Read-only mode is enabled.'
    : conversationAccessRefusal(session.conversationId) });
