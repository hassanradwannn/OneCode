import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prependUserPrompt } from '../src/shared/user-prompt.js';
const store = vi.hoisted(() => ({ getSession: vi.fn(), listSessionPage: vi.fn(), readEvents: vi.fn(), readHandoff: vi.fn() }));
vi.mock('../src/main/session/store.js', () => store);
import { readSessionHistoryFile } from '../src/main/session/history-files.js';
const id = '11111111-2222-4333-8444-555555555555';
beforeEach(() => {
  vi.resetAllMocks();
  store.getSession.mockResolvedValue({ id, title: 'Retained task' });
  store.readEvents.mockResolvedValue([]);
});
describe('read-only local session files', () => {
  it('discovers old sessions and the next catalog page without exposing profile metadata', async () => {
    store.listSessionPage.mockResolvedValue({ sessions: [{ id, title: 'Task', updatedAt: 123,
      conversationId: 'private-provider-route', privateField: 'hidden', lastHandoffId: '2026-10-18-abcdef12' }], nextCursor: { updatedAt: 122, id } });
    const result = JSON.parse((await readSessionHistoryFile('/sessions/.catalog.json'))!);
    expect(result.sessions[0]).toEqual({ id, title: 'Task', updatedAt: 123,
      history: `/sessions/${id}/history.md`, handoff: `/sessions/${id}/handoffs/2026-10-18-abcdef12.md` });
    expect(result.next).toBe(`/sessions/catalog/122-${id}.json`);
    await readSessionHistoryFile(result.next);
    expect(store.listSessionPage).toHaveBeenLastCalledWith({ limit: 200, cursor: { updatedAt: 122, id } });
  });
  it.each(['chatgpt', 'gemini'])('reads stored %s messages and tool outcomes without running work or exporting authorization', async provider => {
    const key = 'sk-gemini-session-' + 'a'.repeat(43);
    store.readEvents.mockResolvedValue([
      { seq: 1, time: 1, kind: 'user_message', message: { text: prependUserPrompt('Please inspect the task', `session_key=${key}`) + `\n[[GEMINI_LOCAL_SESSION]]${key}[[/GEMINI_LOCAL_SESSION]]` } },
      { seq: 2, time: 2, kind: 'assistant_message', message: { text: `${provider} recorded answer` } },
      { seq: 3, time: 3, kind: 'tool_call', call: { tool: 'read', outcome: 'ok', args: { text: '{}' }, result: { text: 'verified hi' } } }
    ]);
    const result = await readSessionHistoryFile(`/sessions/${id}/history.md`);
    expect(result).toContain('Please inspect the task');
    expect(result).toContain(`${provider} recorded answer`);
    expect(result).toContain('verified hi');
    expect(result).not.toContain(key);
    expect(result).not.toContain('session_key=');
    expect(store.readEvents).toHaveBeenCalledWith(id, { from: 0, limit: 251, kinds: ['user_message', 'assistant_message', 'tool_call'] });
  });
  it('pages by canonical sequence even when native chronology differs', async () => {
    const rows = Array.from({ length: 251 }, (_, at) => ({ kind: 'assistant_message', seq: at + 10, time: 251 - at, message: { text: `message ${at}` } }));
    store.readEvents.mockResolvedValue([...rows].reverse());
    const first = await readSessionHistoryFile(`/sessions/${id}/history.md`);
    expect(first).toContain(`/sessions/${id}/pages/260.md`);
    expect(first).toContain('message 249');
    expect(first).not.toContain('message 250');
    store.readEvents.mockResolvedValue([rows[250]]);
    const last = await readSessionHistoryFile(`/sessions/${id}/pages/260.md`);
    expect(last).toContain('message 250');
    expect(last).toContain('End of currently recorded history.');
  });
  it('reads the stored Markdown receipt and reports missing history', async () => {
    store.readHandoff.mockResolvedValue({ text: '# Handoff\n\nVerified work.' });
    expect(await readSessionHistoryFile(`/sessions/${id}/handoffs/2026-10-18-abcdef12.md`)).toBe('# Handoff\n\nVerified work.');
    store.getSession.mockResolvedValue(null);
    await expect(readSessionHistoryFile(`/sessions/${id}/history.md`)).rejects.toThrow('No retained session');
  });
  it('keeps dated recorder session IDs readable alongside desktop UUIDs', async () => {
    const dated = '2026-10-18-1234abcd';
    expect(await readSessionHistoryFile(`/sessions/${dated}/history.md`)).toContain('End of currently recorded history.');
    expect(store.getSession).toHaveBeenCalledWith(dated);
  });
  it.each(['/sessions/../../config.json', `/sessions/${id}/meta.json`, `/sessions/${id}/pages/-1.md`, '/sessions/assets/secret'])('rejects unsupported history paths: %s', async input => {
    await expect(readSessionHistoryFile(input)).rejects.toThrow('Invalid session history path');
    expect(store.readEvents).not.toHaveBeenCalled();
  });
  it('leaves ordinary approved filesystem paths to the existing sandbox', async () => {
    expect(await readSessionHistoryFile('/project/sessions/file.md')).toBeNull();
    expect(store.getSession).not.toHaveBeenCalled();
  });
});
