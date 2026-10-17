import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const source = readFileSync(new URL('../extension/gemini-dom.js', import.meta.url), 'utf8');
let dom: JSDOM;
let document: Document;
let api: any;
let box: HTMLElement;
const id = 'ea972ba88cc341c6';
const key = 'scratch-only-placeholder-key-for-regression-test';
const frame = '\n\n[[GEMINI_LOCAL_SESSION]]\n' + JSON.stringify({ conversation_id: id, session_key: key }) + '\n[[/GEMINI_LOCAL_SESSION]]';
const warmup = '[[GEMINI_LOCAL_WARMUP]] Initialize this local workspace conversation. Reply READY only. Do not call tools.';

beforeEach(() => {
  vi.useFakeTimers();
  dom = new JSDOM('<main><input-container><rich-textarea><div role="textbox" contenteditable="true"></div></rich-textarea><button aria-label="Send message">Send</button></input-container></main>', {
    url: `https://gemini.google.com/app/${id}?pageId=none`, runScripts: 'outside-only', pretendToBeVisual: true
  });
  document = dom.window.document;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{ width: 20, height: 20 }]; } });
  box = document.querySelector('[role="textbox"]')!;
  document.execCommand = (command, _ui, value) => {
    if (command !== 'insertText') return false;
    const selection = document.getSelection();
    if (!selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    range.deleteContents(); range.insertNode(document.createTextNode(value || ''));
    (document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).disabled = !value;
    box.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    if (!value) {
      const cleared = box.innerHTML;
      void Promise.resolve().then(() => {
        if (box.innerHTML !== cleared || box.textContent) return;
        box.innerHTML = '<p><br></p>';
        const caret = document.createRange(); caret.setStart(box.firstElementChild!, 0); caret.collapse(true);
        selection.removeAllRanges(); selection.addRange(caret);
      });
    }
    return true;
  };
  dom.window.eval(source);
  api = (dom.window as any).CLF_DOM;
});
afterEach(() => { dom.window.close(); vi.useRealTimers(); });

function renderStrongMenu(name = 'OneCode') {
      const option = document.createElement('button'); option.setAttribute('role', 'menuitem'); option.className = 'at-mentions-v2-item';
      option.setAttribute('aria-label', name); option.textContent = name;
      option.addEventListener('click', () => {
        const remaining = box.textContent!.replace(/^@/, '');
        const paragraph = document.createElement('p'), strong = document.createElement('strong'); strong.textContent = '@' + name;
        paragraph.append(strong, document.createTextNode(' ' + remaining)); box.replaceChildren(paragraph);
        document.querySelectorAll('.at-mentions-v2-item').forEach(node => node.remove());
      }); document.body.append(option); return option;
}
describe('configured connector presentation', () => {
  it('selects a uniquely provider-formatted configured device name and retains the exact native token', async () => {
    const required = 'OneCode Core legion-laptop', rendered = 'OneCode Core Legion Laptop';
    api.setConnectorNames({ core: required }); api.insertPrompt('Exact task', true);
    const edit = document.execCommand;
    document.execCommand = (command, ui, value) => { const result = edit(command, ui, value); if (value === '@') renderStrongMenu(rendered); return result; };
    const send = vi.spyOn(document.querySelector('button')!, 'click');
    const selected = api.selectConnector(required, () => true);
    await vi.advanceTimersByTimeAsync(9000);
    expect(await selected).toBe(true); expect(api.confirmedMention(required)).toBe(true);
    expect(box.querySelector('strong')!.textContent).toBe('@' + rendered);
    expect(api.composerAuthoredText()).toBe('Exact task'); expect(send).not.toHaveBeenCalled();
  });
  it.each([
    ['OneCode Core Legion Laptop', 'OneCode Core legion laptop'],
    ['OneCode Core Legion Laptop 2'],
    ['OneCode Core Desktop']
  ])('refuses ambiguous or different-device menu names: %j', async (...labels) => {
    const required = 'OneCode Core legion-laptop'; api.setConnectorNames({ core: required }); api.insertPrompt('Exact task', true);
    const edit = document.execCommand;
    document.execCommand = (command, ui, value) => { const result = edit(command, ui, value); if (value === '@') labels.forEach(label => renderStrongMenu(label)); return result; };
    const selected = api.selectConnector(required, () => true);
    await vi.advanceTimersByTimeAsync(9000);
    expect(await selected).toBe(false); expect(api.confirmedMention(required)).toBe(false);
    expect(api.composerAuthoredText()).toBe('Exact task');
  });

});
