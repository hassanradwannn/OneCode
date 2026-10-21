import type { ChatProvider } from './chat-provider.js';

export interface ChatScheduleRun {
  inputId: string;
  dueAt: number;
  text: string;
  state: 'reserved' | 'queued' | 'sent' | 'failed' | 'cancelled';
  detail?: string;
}
export interface ChatSchedule {
  id: string;
  key: string;
  sessionId: string;
  provider: ChatProvider;
  title: string;
  message: string;
  intervalMinutes: number;
  enabled: boolean;
  createdAt: number;
  nextRunAt: number;
  lastError?: string;
  runs: ChatScheduleRun[];
}

export const CHAT_SCHEDULE_INSTRUCTIONS = 'For a requested completion check, hourly check, cron job, reminder or repeated follow-up on this computer, use OneCode Core automations. Create it with the requested interval_minutes and message in this exact chat; the app durably sends that message at each interval until cancelled. Inspect the returned schedule and next_run_at before claiming it is scheduled. A provider-native Monitoring card alone does not register a OneCode schedule. Never create both for the same request. Keep the PC awake, OneCode running and the provider signed in. Existing tool permissions still apply on every run. Report actual process errors or missing outputs; a scheduled or sent message is not proof a check executed or the work completed. Use automations list/update/cancel for this chat. Discover it through Core plugins action=list if the current chat has a cached tool list.';
