import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const question = '11111111-2222-4333-8444-555555555555';
const answer = '22222222-3333-4444-8555-666666666666';
function page(extraUser = '', searchAnswer = true) {
  const dom = new JSDOM(`<main data-app-shell-main-surface><div data-thread-find-target="conversation"><div data-turn-key="${question}">
    <div data-content-search-turn-key="fallback-turn-0">
      <div data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="${question}"><div data-user-message-bubble><div class="whitespace-pre-wrap">Read the attached file.</div></div></div>
      ${extraUser}
      ${searchAnswer ? `<div data-chatgpt-search-unit-key="fallback-turn-0:1:assistant" data-chatgpt-search-message-ids="${answer}"><div class="markdown">Done.</div></div>`
        : '<div data-markdown-text-style="assistant-message">Done.</div>'}
    </div></div></div></main>`, { url: 'https://chatgpt.com/c/33333333-4444-4555-8666-777777777777', runScripts: 'outside-only' });
  dom.window.eval(source);
  return { dom, api: (dom.window as any).CLF_DOM };
}

it('reads the current search-unit question inside its shell exchange exactly once', () => {
  const { dom, api } = page();
  try {
    expect(api.turns().map((turn: any) => turn.role)).toEqual(['user', 'assistant']);
    expect(api.messages().filter((message: any) => message.role === 'user')).toMatchObject([
      { id: question, text: 'Read the attached file.', turnId: question }
    ]);
    expect(api.messages().filter((message: any) => message.id === question)).toHaveLength(1);
  } finally { dom.window.close(); }
});

it('keeps two native user slots in the same shell exchange ambiguous', () => {
  const { dom, api } = page('<div data-chatgpt-search-unit-key="fallback-turn-0:2:user" data-chatgpt-search-message-ids="another-id">Different question</div>');
  try { expect(api.turns()).toEqual([]); } finally { dom.window.close(); }
});

it('recognizes a short native assistant answer without a search-unit or agent-start wrapper', () => {
  const { dom, api } = page('', false);
  try { expect(api.turns().map((turn: any) => turn.role)).toEqual(['user', 'assistant']); }
  finally { dom.window.close(); }
});

it.each([true, false])('reads a nested legacy slot and new wrapper for the same native question once (inner identified: %s)', identified => {
  const { dom, api } = page();
  try {
    const outer = dom.window.document.querySelector('[data-chatgpt-search-unit-key$=":user"]')!;
    const inner = dom.window.document.createElement('div');
    inner.setAttribute('data-content-search-unit-key', 'fallback-turn-0:0:user');
    if (identified) inner.setAttribute('data-message-id', question);
    inner.setAttribute('data-message-author-role', 'user');
    while (outer.firstChild) inner.append(outer.firstChild);
    outer.append(inner);
    expect(api.turns().map((turn: any) => turn.role)).toEqual(['user', 'assistant']);
    expect(api.messages().filter((message: any) => message.role === 'user')).toMatchObject([{ id: question, text: 'Read the attached file.' }]);
  } finally { dom.window.close(); }
});
