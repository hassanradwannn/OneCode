import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
const feedback = `<section id="feedback"><h2>Which option do you prefer?</h2><p>Improve your experience by letting us know which option is better</p><nav><button>Option 1</button><button>Option 2</button></nav><div id="answer"><span>Thinking</span><button id="thinking">Skip</button></div><footer><button id="feedback-skip">Skip</button><button disabled>I prefer this option</button></footer></section>`;
function fixture(html: string, url = 'https://chatgpt.com/c/6ad34633-bcf4-83ea-9d25-47002ce00000') {
  const page = new JSDOM(html, { url, runScripts: 'outside-only' });
  Object.defineProperty(page.window.HTMLElement.prototype, 'getClientRects', { value() { return this.closest('[hidden]') ? [] : [{ width: 10, height: 10 }]; } });
  page.window.eval(source);
  return { page, doc: page.window.document, dismiss: () => (page.window as any).CLF_DOM.dismissComparisonPreference() };
}
it('dismisses only the comparison footer while a real thinking Skip is present, once per control', () => {
  const f = fixture(feedback); const skip = vi.fn(), thinking = vi.fn();
  f.doc.getElementById('feedback-skip')!.addEventListener('click', skip);
  f.doc.getElementById('thinking')!.addEventListener('click', thinking);
  expect(f.dismiss()).toBe(true); expect(f.dismiss()).toBe(false);
  expect(skip).toHaveBeenCalledOnce(); expect(thinking).not.toHaveBeenCalled(); f.page.window.close();
});
it.each([
  '<section><h2>Thinking</h2><button>Skip</button></section>',
  feedback.replace('Option 2', 'Other'),
  feedback.replace('Which option do you prefer?', 'Which folder should I delete?'),
  feedback.replace('<section id="feedback">', '<section id="feedback" hidden>'),
  feedback.replace('<button id="feedback-skip">', '<button id="feedback-skip" disabled>'),
  feedback.replace('<footer>', '<footer data-testid="reasoning">'),
  `<article data-message-author-role="assistant">${feedback}</article>`,
  feedback.replace('<button id="thinking">', '<button id="thinking" hidden>').replace('<button id="feedback-skip">Skip</button>', ''),
  feedback.replace('<footer>', '<footer><button>Skip</button>')
])('leaves thinking, ambiguous, disabled, hidden and authored controls untouched', html => {
  const f = fixture(html); const clicks = vi.fn(); f.doc.addEventListener('click', clicks);
  expect(f.dismiss()).toBe(false); expect(clicks).not.toHaveBeenCalled(); f.page.window.close();
});
it('does not act on a different provider or arbitrary website', () => {
  const f = fixture(feedback, 'https://gemini.google.com/app');
  expect(f.dismiss()).toBe(false); f.page.window.close();
});
