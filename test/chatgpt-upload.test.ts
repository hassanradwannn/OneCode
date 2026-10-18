import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../extension/chatgpt-dom.js', import.meta.url), 'utf8');
let dom: JSDOM, document: Document, api: any;
beforeEach(() => {
  vi.useFakeTimers();
  dom = new JSDOM('<form><div id="prompt-textarea" contenteditable="true">Read the exact file.</div><input type="file"><div data-composer-attachments></div><button type="button" data-testid="send-button"></button></form>',
    { url: 'https://chatgpt.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  document = dom.window.document;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => [{ width: 100, height: 40 }] });
  Object.defineProperty(dom.window, 'DataTransfer', { value: class {
    files: File[] = []; items = { add: (file: File) => this.files.push(file) };
  } });
  Object.defineProperty(document.querySelector('input'), 'files', { writable: true, value: [] });
  dom.window.eval(source); api = (dom.window as any).CLF_DOM;
});
afterEach(() => { dom.window.close(); vi.useRealTimers(); });

function tile(name: string) {
  const node = document.createElement('span');
  const open = document.createElement('button'); open.setAttribute('aria-label', name);
  const label = document.createElement('span'); label.textContent = name;
  const remove = document.createElement('button'); remove.setAttribute('aria-label', `Remove ${name}`);
  node.append(open, label, remove); document.querySelector('[data-composer-attachments]')!.append(node);
  return remove;
}

it.each(['report.txt', 'report(1).txt', 'report(27).txt'])('accepts an exclusively uploaded native file named %s before first observation', async name => {
  const draft = api.captureComposerDraft('Read the exact file.');
  document.querySelector('input')!.addEventListener('change', () => tile(name));
  expect(await api.uploadImages([], () => true, draft, [new dom.window.File(['proof'], 'report.txt')])).toBe(true);
  expect(api.composerAttachmentNames()).toEqual([name]);
  expect(draft.current()).toBe(true); draft.dispose();
});

it.each(['different.txt', 'report(1).exe', 'report(copy).txt', 'report(0).txt'])('refuses an unrelated or unsupported native filename %s', async name => {
  const draft = api.captureComposerDraft('Read the exact file.');
  document.querySelector('input')!.addEventListener('change', () => tile(name));
  const pending = api.uploadImages([], () => true, draft, [new dom.window.File(['proof'], 'report.txt')]);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(await pending).toBe(false); draft.dispose();
});

it('refuses a collision rename after the draft changes', async () => {
  const draft = api.captureComposerDraft('Read the exact file.');
  document.querySelector('input')!.addEventListener('change', () => {
    tile('report(1).txt'); document.querySelector('#prompt-textarea')!.textContent = 'A different task';
  });
  expect(await api.uploadImages([], () => true, draft, [new dom.window.File(['proof'], 'report.txt')])).toBe(false);
  draft.dispose();
});

it('refuses an extra attachment even when the requested collision rename exists', async () => {
  const draft = api.captureComposerDraft('Read the exact file.');
  document.querySelector('input')!.addEventListener('change', () => { tile('report(1).txt'); tile('other.txt'); });
  expect(await api.uploadImages([], () => true, draft, [new dom.window.File(['proof'], 'report.txt')])).toBe(false);
  draft.dispose();
});
