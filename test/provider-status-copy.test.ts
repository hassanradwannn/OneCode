// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { chatErrorPresentation } from '../src/renderer/chat-error.js';
import { HISTORY_RATE_LIMIT_TEXT, neutralProgressCopy } from '../src/shared/provider-copy.js';
import { APPROVAL_ANSWERED_TEXT, APPROVAL_WAITING_TEXT } from '../src/shared/approval-wait.js';
import { CONVERSATION_DELETED, isConversationDeleted } from '../src/shared/chat-error.js';
import type { SessionEvent } from '../src/shared/session.js';

type ChatError = Extract<SessionEvent, { kind: 'chat_error' }>;
const error = (text: string): ChatError => ({ kind: 'chat_error', seq: 1, time: Date.now(), turnId: 'turn',
  source: 'app', blocking: true, recoverable: false, retryAt: Date.now() + 60_000,
  message: { text, truncated: false } });

it.each([
  'Gemini temporarily limited access to this conversation history. OneCode is pausing automatic recovery until the retry wait ends.',
  'ChatGPT temporarily rate-limited loading this conversation history. Chat On Steroids is pausing automatic recovery until the retry wait ends.',
  HISTORY_RATE_LIMIT_TEXT
])('shows shared history-limit notices neutrally, including saved history: %s', text => {
  const event = error(text), before = structuredClone(event);
  const view = chatErrorPresentation(event);
  expect(view.title).toBe('Provider reported a problem');
  expect(view.message).toBe(HISTORY_RATE_LIMIT_TEXT);
  expect(view.next).toContain('Provider asked to wait until');
  expect(view.resolved).toBe(false);
  expect(event).toEqual(before);
});

it('keeps actual provider errors and user-supplied provider names verbatim', () => {
  const text = 'Gemini is named in my ChatGPT project: native error 123.';
  expect(chatErrorPresentation(error(text)).message).toBe(text);
});

it('retains waiting/answered and deleted-chat recognition across copy changes', () => {
  expect(neutralProgressCopy('Gemini is waiting for you to allow or deny a tool call in this chat. Nothing continues until you answer it there.')).toBe(APPROVAL_WAITING_TEXT);
  expect(neutralProgressCopy('The tool approval Gemini asked for in this chat was answered.')).toBe(APPROVAL_ANSWERED_TEXT);
  for (const text of [CONVERSATION_DELETED, 'This chat was deleted in Gemini. Start a new chat to continue.',
    'This chat was deleted in ChatGPT. Start a new chat to continue.']) {
    expect(isConversationDeleted(text)).toBe(true);
    expect(chatErrorPresentation(error(text)).next).toContain('Start a new chat');
  }
  expect(isConversationDeleted('The user asked whether this chat was deleted in Gemini.')).toBe(false);
});

it('ships a neutral Companion history-limit message matching the desktop presentation', () => {
  const catalog = JSON.parse(readFileSync('extension/_locales/en/messages.json', 'utf8'));
  expect(catalog.content_history_rate_limited.message).toBe(HISTORY_RATE_LIMIT_TEXT);
});
