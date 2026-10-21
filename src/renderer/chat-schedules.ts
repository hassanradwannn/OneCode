import type { ChatSchedule } from '../shared/chat-schedules.js';
import { el, run } from './dom.js';
import { t } from './i18n.js';

export function initChatSchedules(): void {
  const host = document.getElementById('chatSchedules');
  const refreshButton = document.getElementById('refreshChatSchedules') as HTMLButtonElement | null;
  if (!host || !refreshButton) return;
  let busy = false, signature = '';
  const paint = (rows: ChatSchedule[]) => {
    const next = JSON.stringify(rows); if (next === signature) return; signature = next;
    host.replaceChildren();
    if (!rows.length) { host.append(el('p', 'muted', () => t('No scheduled checks. Ask the agent to repeat a check at an interval.'))); return; }
    for (const schedule of rows) {
      const row = el('div', 'setting'); const text = el('span', 'setting-text');
      text.append(el('b', '', schedule.title));
      text.append(el('em', '', `${schedule.provider === 'gemini' ? 'Gemini' : 'ChatGPT'} · ${schedule.intervalMinutes} min · ${schedule.enabled ? new Date(schedule.nextRunAt).toLocaleString() : t('Cancelled')}`));
      const latest = schedule.runs.at(-1);
      if (schedule.lastError || latest?.detail) text.append(el('em', 'error', schedule.lastError || latest!.detail!));
      else if (latest) text.append(el('em', '', `${t('Last scheduled message')}: ${latest.state}`));
      text.append(el('em', '', schedule.message)); row.append(text);
      if (schedule.enabled) {
        const cancel = el('button', 'btn', () => t('Cancel schedule')) as HTMLButtonElement; cancel.type = 'button';
        cancel.onclick = async () => { cancel.disabled = true; try { await run(window.api.cancelSchedule(schedule.id)); await refresh(); } finally { cancel.disabled = false; } };
        row.append(cancel);
      }
      host.append(row);
    }
  };
  const refresh = async () => {
    if (busy) return; busy = true;
    try { const rows = await run(window.api.listSchedules()); if (Array.isArray(rows)) paint(rows); }
    finally { busy = false; }
  };
  refreshButton.onclick = () => { void refresh(); };
  const timer = window.setInterval(() => { if (!document.hidden && host.offsetParent !== null) void refresh(); }, 5000);
  window.addEventListener('unload', () => window.clearInterval(timer), { once: true });
  void refresh();
}
