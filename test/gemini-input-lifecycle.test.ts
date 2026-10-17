import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const source=readFileSync(new URL('../extension/gemini-dom.js',import.meta.url),'utf8');
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

function turn(role: 'user' | 'assistant', text: string, nativeId: string) {
  const element = document.createElement(role === 'user' ? 'user-query' : 'model-response');
  element.id = nativeId;
  const content = document.createElement(role === 'user' ? 'div' : 'message-content');
  content.className = role === 'user' ? 'query-text' : 'markdown'; content.textContent = text;
  element.append(content); document.querySelector('main')!.prepend(element); return element;
}
function binding(overrides = {}) {
  return { conversation_id: id, session_id: 'local-session-test', session_key: key, connector_name: 'OneCode',
    auto_approve: true, enabled_tools: ['append session note'], ...overrides };
}
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
function nativeStrongMenu(includeSkill = false) {
  const edit = document.execCommand;
  document.execCommand = (command, ui, value) => {
    const done = edit(command, ui, value);
    if (value === '@') { renderStrongMenu(); if (includeSkill) renderStrongMenu('gemini-code'); }
    else document.querySelectorAll('.at-mentions-v2-item').forEach(node => node.remove());
    return done;
  };
}
describe('native Gemini input ownership',()=>{
it('accepts an explicit native model accessibility label without opening or changing the picker',async()=>{
const picker=document.createElement('button');picker.ariaLabel='Open mode picker, currently Gemini Flash-Lite';picker.textContent='arrow_drop_down';document.body.append(picker);
const click=vi.spyOn(picker,'click');expect(api.visibleModelSelection()).toEqual({model:'Gemini Flash-Lite',reasoningEffort:null});
const pending=api.selectModelSettings('gemini-current',null);await vi.advanceTimersByTimeAsync(100);expect(await pending).toBe(true);expect(click).not.toHaveBeenCalled();});
  it.each(['accepted', 'rejected', 'foreign edit', 'changed route', 'retired claim', 'lost Core token'] as const)('prepares native attachments only after tool-free warmup and Core selection, before real task authorization: %s', async outcome => {
    dom.window.history.replaceState({}, '', '/u/1/app');
    const task = 'Inspect the attached scratch files.'; api.insertPrompt(task, true);
    api.setOpeningClaim({ id: 'attachment-input', owner: 'attachment-owner' }); nativeStrongMenu();
    const sequence: string[] = [], nativeSends: string[] = [], why: string[] = []; let alive = true;
    api.setBindingResolver(async () => { sequence.push('binding'); return binding(); });
    document.querySelector('button[aria-label="Send message"]')!.addEventListener('click', () => {
      nativeSends.push(api.composerAuthoredText()); sequence.push(nativeSends.length === 1 ? 'warmup' : 'task');
      const user = turn('user', box.textContent || '', nativeSends.length === 1 ? 'warmup' : 'task'); box.replaceChildren();
      if (nativeSends.length === 1) {
        dom.window.history.replaceState({}, '', `/u/1/app/${id}`);
        const response = document.createElement('model-response'); response.textContent = 'READY'; user.after(response);
      }
    });
    const attachments = vi.fn(async (current: () => boolean) => {
      expect(current()).toBe(true); expect(api.conversationId()).toBe(id); expect(api.preparedConversation()).toBe(id);
      expect(api.composerAuthoredText()).toBe(task); expect(nativeSends).toEqual([warmup]);
      expect(sequence).toEqual(['warmup', 'binding']); expect(api.confirmedMention('OneCode')).toBe(true); sequence.push('attachments');
      if (outcome === 'foreign edit') box.textContent = 'Preserve my replacement';
      if (outcome === 'changed route') dom.window.history.replaceState({}, '', '/app/9c16a67b1d474b59');
      if (outcome === 'retired claim') alive = false;
      if (outcome === 'lost Core token') box.querySelector('strong')!.remove();
      return outcome !== 'rejected';
    });
    const authorize = vi.fn(() => { sequence.push('authorize'); return true; });
    const pending = api.send({ prepareAttachments: attachments, stillCurrent: () => alive, beforeSend: authorize, explain: (reason: string) => why.push(reason) });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toBe(outcome === 'accepted'); expect(attachments).toHaveBeenCalledOnce();
    if (outcome === 'accepted') {
      expect(sequence).toEqual(['warmup', 'binding', 'attachments', 'authorize', 'task']);
      expect(nativeSends).toEqual([warmup, task]); expect(authorize).toHaveBeenCalledOnce();
      expect(api.preparedConversation()).toBe(id);
      const next = {id:'next-authored-input',owner:'next-authored-owner'};
      api.setInputClaim(next);
      expect(api.preparedConversation()).toBeNull();
      const resolveNext = vi.fn(async (conversation: string, opening: unknown, command: unknown, input: unknown) => {
        expect(conversation).toBe(id); expect(opening).toBeNull(); expect(command).toBeNull(); expect(input).toEqual(next);
        return binding();
      });
      api.setBindingResolver(resolveNext);
      api.insertPrompt('Independent follow-up after the completed opening', true);
      const followup = api.send({stillCurrent:()=>true,beforeSend:()=>false});
      await vi.advanceTimersByTimeAsync(3000);
      expect(await followup).toBe(false); expect(resolveNext).toHaveBeenCalledOnce();
      expect(nativeSends).toEqual([warmup,task]);
    } else {
      expect(sequence).toEqual(['warmup', 'binding', 'attachments']); expect(authorize).not.toHaveBeenCalled();
      expect(nativeSends).toEqual([warmup]); expect(why).toEqual([outcome === 'lost Core token' ? 'connector-token-unconfirmed' : 'attachment-upload-unconfirmed']);
      if (outcome === 'foreign edit') expect(box.textContent).toBe('Preserve my replacement');
    }
  });

});
