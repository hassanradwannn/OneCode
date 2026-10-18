import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prependUserPrompt } from '../src/shared/user-prompt.js';

const source = readFileSync(new URL('../extension/gemini-dom.js', import.meta.url), 'utf8');
const recorderSource = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const nativeApprovalReply = readFileSync(new URL('./fixtures/gemini-native-approval-reply.html', import.meta.url), 'utf8');
const markdownSource = readFileSync(new URL('../extension/gemini-markdown.js', import.meta.url), 'utf8');
const nativeUploadCompleted = readFileSync(new URL('./fixtures/gemini-native-upload-completed.html', import.meta.url), 'utf8');
const nativeUploadInputOwner = readFileSync(new URL('./fixtures/gemini-native-upload-input-owner.html', import.meta.url), 'utf8');
const nativePlanFinal = readFileSync(new URL('./fixtures/gemini-native-plan-final.html', import.meta.url), 'utf8');
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
it('reads assistant prose only from native message content, never a connecting/approval shell', () => {
  const shell = document.createElement('model-response'); shell.id = 'response-shell';
  shell.innerHTML = '<div class="response-container-header">Connecting to OneCode Core Desktop</div><remy-confirmation-card><span>OneCode Core Desktop</span><button>Allow</button></remy-confirmation-card>';
  document.querySelector('main')!.prepend(shell);
  expect(api.messages()).toEqual([]);
  const content = document.createElement('message-content'); content.textContent = 'Connecting to OneCode Core Desktop is the phrase you asked me to quote.';
  const outer = document.createElement('structured-content-container'); outer.className = 'model-response-text';
  outer.append(document.createTextNode('OneCode Core Desktop'), content); shell.append(outer);
  expect(api.messages().map((message: any) => message.text)).toEqual(['Connecting to OneCode Core Desktop is the phrase you asked me to quote.']);
});
function card(tool = 'append session note', connector = 'OneCode') {
  const element = document.createElement('remy-confirmation-card');
  const title = document.createElement('span'); title.dataset.testId = 'header'; title.textContent = connector;
  const body = document.createElement('div'); body.dataset.testId = 'body';
  const permission = document.createElement('p'); permission.textContent = `Let Gemini use "${tool}" from ${connector}`; body.append(permission);
  const deny = document.createElement('button'); deny.textContent = 'Deny';
  const allow = document.createElement('button'); allow.textContent = 'Allow';
  element.append(title, body, deny, allow); document.querySelector('main')!.append(element);
  return { element, allow, deny };
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
function nativeAttachment(name: string, host: Element = box.parentElement!) {
  const container = document.createElement('div'); container.innerHTML = nativeUploadCompleted;
  const original = [...container.querySelectorAll('uploader-file-preview')].find(row => {
    const description = row.querySelector('[aria-describedby]')?.getAttribute('aria-describedby');
    return Boolean(description && container.querySelector(`[id="${description}"]`)?.textContent?.endsWith(name.endsWith('.png') ? '.png' : '.txt'));
  })!;
  const row = original.cloneNode(true) as HTMLElement, tooltip = document.createElement('div');
  tooltip.id = 'native-file-tooltip-' + Math.random().toString(36).slice(2); tooltip.role = 'tooltip'; tooltip.textContent = name;
  row.querySelector('[aria-describedby]')!.setAttribute('aria-describedby', tooltip.id);
  host.append(row); document.body.append(tooltip); return { row, tooltip };
}
const nativeModelChoices = [
  { id: '8c46e95b1a07cecc', label: '3.5 Flash-Lite' }, { id: '56fdd199312815e2', label: '3.6 Flash' }, { id: 'e6fa609c3fa255c0', label: '3.1 Pro' }
] as const;
function nativeModePicker(selected: string = nativeModelChoices[1].id) {
  const picker = document.createElement('button'); picker.ariaLabel = 'Open mode picker, currently Gemini Flash'; picker.textContent = 'Gemini\nFlash';
  let selection = selected; const clicks: string[] = [];
  const render = () => {
    const menu = document.createElement('div'); menu.dataset.nativeModels = 'true';
    for (const choice of [...nativeModelChoices, { id: 'upsell_MODE_CATEGORY_ULTRA', label: '4 Argon' }]) {
      const row = document.createElement('gem-menu-item'); row.role = 'menuitem'; row.setAttribute('data-mode-id', choice.id); row.setAttribute('aria-disabled', 'false');
      row.innerHTML = '<gem-menu-item-content><span class="label"></span><div class="sublabel">Native description</div></gem-menu-item-content>';
      row.querySelector('.label')!.textContent = choice.label;
      if (choice.id === selection) { row.classList.add('selected'); const selected = document.createElement('gem-icon'); selected.ariaLabel = 'Selected'; row.prepend(selected); }
      if (choice.id.startsWith('upsell')) row.insertAdjacentHTML('beforeend', '<mat-icon data-mat-icon-name="lock"></mat-icon>');
      row.addEventListener('click', () => { clicks.push(choice.id); selection = choice.id; menu.remove(); }); menu.append(row);
    }
    menu.insertAdjacentHTML('beforeend', '<gem-menu-item role="menuitem" value="thinking_level"><span class="label">Thinking level</span></gem-menu-item>');
    document.body.append(menu);
  };
  picker.addEventListener('click', () => { const current = document.querySelector('[data-native-models]'); if (current) current.remove(); else render(); });
  document.querySelector('input-container,input-area-v2')!.append(picker); return { picker, selected: () => selection, render, clicks };
}
function nativeUploadSurface(change: (files: File[], host: HTMLElement) => void, ambiguous = false) {
  const old = document.querySelector('input-container')!, host = document.createElement('input-area-v2');
  host.append(...old.childNodes); old.replaceWith(host);
  const win: any = dom.window;
  win.DataTransfer = class { values: File[] = []; items = { add: (file: File) => { this.values.push(file); } }; get files() { return this.values; } };
  const trigger = document.createElement('button'); trigger.ariaLabel = 'Upload and tools'; trigger.setAttribute('aria-expanded', 'false'); host.append(trigger);
  let input: HTMLInputElement | null = null;
  trigger.addEventListener('click', () => {
    const existing = document.querySelector('mat-action-list[aria-label="Menu options"]');
    if (existing) { existing.remove(); trigger.setAttribute('aria-expanded', 'false'); return; }
    trigger.setAttribute('aria-expanded', 'true');
    const menu = document.createElement('mat-action-list'); menu.role = 'menu'; menu.ariaLabel = 'Menu options';
    menu.innerHTML = nativeUploadInputOwner;
    const owner = menu.querySelector('images-files-uploader')!;
    if (ambiguous) owner.after(owner.cloneNode(true));
    input = owner.querySelector('input')!; let files: File[] = [];
    Object.defineProperty(input, 'files', { get: () => files, set: value => { files = [...value]; } });
    input.addEventListener('change', () => { change(files, host); menu.remove(); trigger.setAttribute('aria-expanded', 'false'); });
    document.body.append(menu);
  });
  return { host, trigger, input: () => input };
}

describe('observed native file upload ownership', () => {
  it.each(['nested selector', 'hidden nested selector', 'disabled primary', 'duplicate primary', 'missing primary class', 'hidden owner', 'foreign outer input'] as const)(
    'elects only the captured native direct primary input with %s', async mode => {
    const change = vi.fn((_files: File[], host: HTMLElement) => nativeAttachment('proof.txt', host));
    const surface = nativeUploadSurface(change), otherDispatch = vi.fn(), otherAssignment = vi.fn();
    surface.trigger.addEventListener('click', () => {
      const owner = document.querySelector('images-files-uploader') as HTMLElement | null;
      if (!owner) return;
      const primary = surface.input()!;
      const nested = document.createElement('input'); nested.type = 'file'; nested.multiple = true; nested.className = 'hidden-file-input';
      nested.accept = primary.accept; nested.hidden = mode === 'hidden nested selector';
      Object.defineProperty(nested, 'files', { set: otherAssignment }); nested.addEventListener('change', otherDispatch);
      owner.querySelector('div')!.append(nested);
      document.querySelectorAll('uploader > input').forEach(input => input.addEventListener('change', otherDispatch));
      if (mode === 'disabled primary') primary.disabled = true;
      if (mode === 'duplicate primary') primary.after(primary.cloneNode(true));
      if (mode === 'missing primary class') primary.classList.remove('hidden-file-input');
      if (mode === 'hidden owner') owner.hidden = true;
      if (mode === 'foreign outer input') owner.closest('uploader')!.append(primary);
      expect(owner.querySelectorAll('input[type="file"][multiple]')).toHaveLength(mode === 'duplicate primary' ? 3 : mode === 'foreign outer input' ? 1 : 2);
    });
    api.insertPrompt('Preserve the exact owned upload task', true);
    const pending = api.uploadImages([], () => true, api.captureComposerDraft('Preserve the exact owned upload task'), [new dom.window.File(['proof'], 'proof.txt')]);
    await vi.advanceTimersByTimeAsync(8500);
    const success = mode === 'nested selector' || mode === 'hidden nested selector';
    expect(await pending).toBe(success); expect(change).toHaveBeenCalledTimes(success ? 1 : 0);
    expect(otherAssignment).not.toHaveBeenCalled(); expect(otherDispatch).not.toHaveBeenCalled();
    expect(api.composerAuthoredText()).toBe('Preserve the exact owned upload task');
    if (success) expect(api.composerAttachmentNames()).toEqual(['proof.txt']);
  });
  it('reads all seven captured completed filenames from native accessibility descriptions, outside rich-textarea', () => {
    const { host } = nativeUploadSurface(() => {}); host.insertAdjacentHTML('beforeend', nativeUploadCompleted);
    expect(api.composerBox()).toBe(host); expect(api.hasComposerAttachments()).toBe(true);
    expect(api.composerAttachmentNames()).toEqual(['probe-archive.zip', 'probe-code.py', 'probe-document.pdf', 'probe-note.txt', 'probe-shapes.jpg', 'probe-shapes.png', 'probe-table.csv']);
    host.querySelector('[role="tooltip"]')!.remove();
    expect(api.hasComposerAttachments()).toBe(true); expect(api.composerAttachmentNames()).toHaveLength(6);
  });
  it.each([false, true])('opens the native lazy Files owner, transfers seven mixed files once and confirms exact completed previews (native hover-hidden close controls=%s)', async hiddenClose => {
    const change = vi.fn((_files: File[], host: HTMLElement) => {
      host.insertAdjacentHTML('beforeend', nativeUploadCompleted);
      [...host.querySelectorAll('[role="tooltip"]')].filter(node => node.textContent === 'probe-table.csv').forEach(node => { node.textContent = 'probe-table.csv.txt'; });
      if (hiddenClose) host.querySelectorAll<HTMLElement>('.gem-attachment-close-button button').forEach(button => { button.style.visibility = 'hidden'; });
    });
    const surface = nativeUploadSurface(change); api.insertPrompt('Read these seven scratch fixtures', true);
    const names = ['probe-shapes.png', 'probe-shapes.jpg', 'probe-note.txt', 'probe-document.pdf', 'probe-table.csv', 'probe-code.py', 'probe-archive.zip'];
    const files = names.map(name => new dom.window.File(['scratch'], name, { type: name.endsWith('.png') ? 'image/png' : 'application/octet-stream' }));
    const transportedNames = names.map(name => /\.csv$/i.test(name) ? name + '.txt' : name);
    const draft = api.captureComposerDraft('Read these seven scratch fixtures');
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
    expect(await api.uploadImages([], () => true, draft, files)).toBe(true);
    expect(change).toHaveBeenCalledOnce();
    expect(change.mock.calls[0]![0].map(file => file.name)).toEqual(transportedNames);
    expect(change.mock.calls[0]![0].every((file, index) => names[index]!.endsWith('.csv') ? file.type === 'text/plain' && file.size === files[index]!.size : file === files[index])).toBe(true);
    expect(files.map(file => file.name)).toEqual(names);
    expect(surface.input()!.closest('images-files-uploader')!.getAttribute('data-test-id')).toBe('uploader-images-files-button-advanced');
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0); expect(api.composerAttachmentNames()).toEqual([...transportedNames].sort());
    if (hiddenClose) expect([...surface.host.querySelectorAll('.gem-attachment-close-button button')].every(button => dom.window.getComputedStyle(button).visibility === 'hidden')).toBe(true);
    expect(draft.current()).toBe(true); nativeAttachment('foreign.txt', surface.host); expect(draft.current()).toBe(false);
  });
  it('wraps CSV bytes unchanged as a visible text view while retaining original metadata and all other File objects', async () => {
    const bytes = new Uint8Array([239, 187, 191, 110, 97, 109, 101, 44, 118, 97, 108, 117, 101, 13, 10, 34, 97, 44, 98, 34, 44, 195, 169, 13, 10]);
    const original = new dom.window.File([bytes], 'Exact.CSV', { type: 'text/csv', lastModified: 123456 });
    const ordinary = new dom.window.File(['ordinary'], 'notes.txt', { type: 'text/plain', lastModified: 7 });
    let transferred: File[] = [];
    nativeUploadSurface((files, host) => { transferred = files; files.forEach(file => nativeAttachment(file.name, host)); });
    api.insertPrompt('Read both original files', true);
    expect(await api.uploadImages([], () => true, api.captureComposerDraft('Read both original files'), [original, ordinary])).toBe(true);
    expect(transferred[0]).toMatchObject({ name: 'Exact.CSV.txt', type: 'text/plain', size: original.size, lastModified: 123456 });
    expect(transferred[1]).toBe(ordinary); expect(original).toMatchObject({ name: 'Exact.CSV', type: 'text/csv', size: bytes.length, lastModified: 123456 });
    const read = (file: File) => new Promise<Uint8Array>((resolve, reject) => {
      const reader = new dom.window.FileReader(); reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer)); reader.readAsArrayBuffer(file);
    });
    vi.useRealTimers(); // FileReader owns an asynchronous native task, not the upload polling clock.
    expect(await read(transferred[0]!)).toEqual(bytes); expect(await read(original)).toEqual(bytes);
    expect(api.composerAttachmentNames()).toEqual(['Exact.CSV.txt', 'notes.txt']);
  });
  it('keeps duplicate CSV text views distinct from existing same-batch names without reusing a different file', async () => {
    const names = ['table.csv', 'table.csv', 'table.csv.txt', 'TABLE.CSV (2).txt'];
    const originals = names.map((name, index) => new dom.window.File([String(index)], name, { type: index < 2 ? 'text/csv' : 'text/plain', lastModified: index + 1 }));
    const transferred = vi.fn((files: File[], host: HTMLElement) => files.forEach(file => nativeAttachment(file.name, host)));
    nativeUploadSurface(transferred); api.insertPrompt('Preserve these four distinct files', true);
    expect(await api.uploadImages([], () => true, api.captureComposerDraft('Preserve these four distinct files'), originals)).toBe(true);
    const files = transferred.mock.calls[0]![0];
    expect(files.map(file => file.name)).toEqual(['table.csv (3).txt', 'table.csv (4).txt', 'table.csv.txt', 'TABLE.CSV (2).txt']);
    expect(files.slice(0, 2).map(file => [file.type, file.size, file.lastModified])).toEqual([['text/plain', 1, 1], ['text/plain', 1, 2]]);
    expect(files[2]).toBe(originals[2]); expect(files[3]).toBe(originals[3]); expect(originals.map(file => file.name)).toEqual(names);
  });
  it.each(['original-name preview', 'foreign edit', 'changed route', 'too many files', 'overlong alias'] as const)(
    'retains CSV ownership, name proof and existing limits for %s', async mode => {
    let alive = true;
    const originalName = mode === 'overlong alias' ? 'x'.repeat(508) + '.csv' : 'table.csv';
    const originals = Array.from({ length: mode === 'too many files' ? 21 : 1 }, () =>
      new dom.window.File(['name,value\r\na,1\r\n'], originalName, { type: 'text/csv', lastModified: 99 }));
    const change = vi.fn((_files: File[], host: HTMLElement) => {
      nativeAttachment(mode === 'original-name preview' ? 'table.csv' : 'table.csv.txt', host);
      if (mode === 'foreign edit') box.textContent = 'Preserve this intervening human draft';
      if (mode === 'changed route') dom.window.history.replaceState({}, '', '/u/1/app/9c16a67b1d474b59');
    });
    nativeUploadSurface(change); api.insertPrompt('Read the original CSV bytes', true);
    let settled = false;
    const pending = api.uploadImages([], () => alive, api.captureComposerDraft('Read the original CSV bytes'), originals)
      .then((result: boolean) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(200);
    if (mode === 'original-name preview') { expect(settled).toBe(false); alive = false; await vi.advanceTimersByTimeAsync(200); }
    expect(await pending).toBe(false); expect(change).toHaveBeenCalledTimes(mode === 'too many files' || mode === 'overlong alias' ? 0 : 1);
    expect(originals.every(file => file.name === originalName && file.type === 'text/csv' && file.lastModified === 99)).toBe(true);
    if (mode === 'foreign edit') expect(box.textContent).toBe('Preserve this intervening human draft');
  });
  it.each(['two complete', 'one missing', 'unproven tooltip', 'native busy', 'new alert', 'extra file', 'foreign draft'] as const)(
    'requires each duplicate-name file, native completion and unchanged draft: %s', async mode => {
    let alive = true;
    const surface = nativeUploadSurface((_files, host) => {
      nativeAttachment('same.txt', host);
      if (mode !== 'one missing') nativeAttachment('same.txt', host);
      if (mode === 'unproven tooltip') host.querySelector('[aria-describedby]')!.setAttribute('aria-describedby', 'missing-native-tooltip');
      if (mode === 'native busy') host.insertAdjacentHTML('beforeend', '<mat-progress-spinner role="progressbar" aria-label="Uploading"></mat-progress-spinner>');
      if (mode === 'new alert') document.body.insertAdjacentHTML('beforeend', '<div role="alert">Native scratch upload rejected</div>');
      if (mode === 'extra file') nativeAttachment('someone-else.txt', host);
      if (mode === 'foreign draft') box.textContent = 'Preserve this human draft';
    });
    api.insertPrompt('Original file task', true); const draft = api.captureComposerDraft('Original file task');
    let settled = false; const pending = api.uploadImages([], () => alive, draft,
      [new dom.window.File(['one'], 'same.txt'), new dom.window.File(['two'], 'same.txt')]).then((value: boolean) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(200);
    if (['one missing', 'unproven tooltip', 'native busy'].includes(mode)) { expect(settled).toBe(false); alive = false; await vi.advanceTimersByTimeAsync(200); }
    expect(await pending).toBe(mode === 'two complete');
    expect(api.hasComposerAttachments()).toBe(true); // Failed upload never clears an unsent native file.
    if (mode === 'foreign draft') expect(box.textContent).toBe('Preserve this human draft');
    if (mode === 'two complete') { document.getElementById(surface.host.querySelector('[aria-describedby]')!.getAttribute('aria-describedby')!)!.textContent = 'changed.txt'; expect(draft.current()).toBe(false); }
  });
  it('refuses ambiguous advanced Files owners instead of using another global image/document input', async () => {
    const change = vi.fn(); nativeUploadSurface(change, true); api.insertPrompt('Scratch image task', true);
    const pending = api.uploadImages([{ name: 'scratch.png', dataUrl: 'data:image/png;base64,VEVTVA==' }], () => true, api.captureComposerDraft('Scratch image task'));
    await vi.advanceTimersByTimeAsync(9000); expect(await pending).toBe(false); expect(change).not.toHaveBeenCalled();
    expect(api.composerAuthoredText()).toBe('Scratch image task');
  });
  it('waits for native progress and Send readiness without treating an unrelated sidebar spinner as an upload', async () => {
    const { host } = nativeUploadSurface((_files, host) => {
      nativeAttachment('scratch.png', host); host.insertAdjacentHTML('beforeend', '<mat-progress-spinner role="progressbar"></mat-progress-spinner>');
      const send = document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!; send.disabled = true;
      setTimeout(() => { host.querySelector('[role="progressbar"]')!.remove(); send.disabled = false; }, 500);
    });
    api.insertPrompt('Image task', true); document.body.insertAdjacentHTML('beforeend', '<mat-progress-spinner role="progressbar" aria-label="Loading Gems and Recent conversations"></mat-progress-spinner>');
    let done = false; const pending = api.uploadImages([{ name: 'scratch.png', dataUrl: 'data:image/png;base64,VEVTVA==' }], () => true,
      api.captureComposerDraft('Image task')).then((value: boolean) => { done = true; return value; });
    await vi.advanceTimersByTimeAsync(300); expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(400); expect(await pending).toBe(true); expect(host.querySelector('[role="progressbar"]')).toBeNull();
  });
});

describe('bounded native upload refusal diagnostics', () => {
  it.each([
    ['entry', 'entry-not-owned'], ['trigger', 'trigger-unavailable'], ['ambiguous', 'input-unconfirmed'],
    ['assignment', 'assignment-failed'], ['alert', 'new-alert'], ['extra', 'extra-preview'],
    ['withdrawn', 'lease-withdrawn'], ['incomplete', 'completion-unconfirmed']
  ])('reports only metadata for the exact %s refusal', async (mode, stage) => {
    let alive = mode !== 'entry';
    const log = vi.spyOn(dom.window.console, 'info').mockImplementation(() => {});
    const surface = nativeUploadSurface((_files, host) => {
      if (mode === 'alert') document.body.insertAdjacentHTML('beforeend', '<div role="alert">Private provider error must remain private</div>');
      if (mode === 'extra') { nativeAttachment('private-upload.txt', host); nativeAttachment('foreign-private.txt', host); }
      if (mode === 'withdrawn') alive = false;
    }, mode === 'ambiguous');
    if (mode === 'trigger') surface.trigger.remove();
    if (mode === 'assignment') (dom.window as any).DataTransfer = class { constructor() { throw new Error('Private native error'); } };
    api.insertPrompt('Private authored upload task ' + key, true);
    const draft = api.captureComposerDraft('Private authored upload task ' + key);
    const pending = api.uploadImages([], () => alive, draft, [new dom.window.File(['PRIVATE_BYTES'], 'private-upload.txt')]);
    await vi.advanceTimersByTimeAsync(mode === 'incomplete' ? 600100 : 9000);
    expect(await pending).toBe(false);
    const line = String(log.mock.calls.find(call => String(call[0]).startsWith('[OneCode upload] '))![0]);
    const diagnostic = JSON.parse(line.slice('[OneCode upload] '.length));
    expect(diagnostic).toMatchObject({ stage, requested: 1, dispatchAttempted: !['entry', 'trigger', 'ambiguous', 'assignment'].includes(mode) });
    expect(Object.keys(diagnostic).sort()).toEqual(['stage', 'requested', 'ownerCount', 'inputCount', 'primaryInputCount', 'previewCount', 'namesMatched',
      'completedPreviews', 'dispatchAttempted', 'callerCurrent', 'draftCurrent', 'editorSame', 'hostSame', 'routeMatches', 'trustedEditRevoked',
      'progressCount', 'alertCount', 'sendPresent', 'sendEnabled'].sort());
    for (const privateValue of ['Private', 'private-upload.txt', 'foreign-private.txt', 'PRIVATE_BYTES', key, dom.window.location.href]) expect(line).not.toContain(privateValue);
  });
});

describe('observed native model choices', () => {
    it('reads the compact native model header from its explicit accessibility label without opening or changing it', async () => {
      box.innerHTML = '<p><br></p>';
      const mode = nativeModePicker(), clicked = vi.fn();
      mode.picker.textContent = 'arrow_drop_down';
      mode.picker.setAttribute('aria-label', 'Open mode picker, currently Gemini Flash-Lite');
      mode.picker.addEventListener('click', clicked);
      expect(api.visibleModelSelection()).toEqual({model:'gemini-current',reasoningEffort:null});
      const pending = api.selectModelSettings('gemini-current', null);
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toBe(true);
      expect(clicked).not.toHaveBeenCalled();
      expect(mode.clicks).toEqual([]);
    });
  it.each(['gemini-current', nativeModelChoices[1].id])('waits for the fresh native picker after the same editor is already writable: %s', async model => {
    box.innerHTML = '<p><br></p>';
    const nativeClick = vi.fn(); let mode: ReturnType<typeof nativeModePicker> | undefined;
    let complete = false;
    const pending = api.selectModelSettings(model, null).then((result: boolean) => { complete = true; return result; });
    expect(api.composerWritable()).toBe(true);
    await vi.advanceTimersByTimeAsync(300); expect(complete).toBe(false);
    mode = nativeModePicker(); mode.picker.addEventListener('click', nativeClick);
    await vi.advanceTimersByTimeAsync(300);
    expect(await pending).toBe(true); expect(mode.selected()).toBe(nativeModelChoices[1].id);
    expect(mode.clicks).toEqual([]); expect(nativeClick).toHaveBeenCalledTimes(model === 'gemini-current' ? 0 : 2);
    expect(document.querySelector('[data-native-models]')).toBeNull();
    expect(box.innerHTML).toBe('<p><br></p>');
  });
  it.each(['disabled', 'unreadable'] as const)('waits for the same native picker to become usable without clicking it early: %s', async state => {
    const mode = nativeModePicker(), clicked = vi.fn(); mode.picker.addEventListener('click', clicked);
      if (state === 'disabled') mode.picker.disabled = true;
      else { mode.picker.textContent = ''; mode.picker.setAttribute('aria-label', 'Open mode picker'); }
    let complete = false;
    const pending = api.selectModelSettings(nativeModelChoices[0].id, null).then((result: boolean) => { complete = true; return result; });
    await vi.advanceTimersByTimeAsync(300); expect(complete).toBe(false); expect(clicked).not.toHaveBeenCalled();
    mode.picker.disabled = false; mode.picker.textContent = 'Gemini\nFlash';
    await vi.advanceTimersByTimeAsync(300); expect(await pending).toBe(true); expect(mode.selected()).toBe(nativeModelChoices[0].id);
  });
  it.each(['claim', 'route', 'editor', 'draft', 'attachments', 'generating'] as const)(
    'refuses a changed original lease while waiting for the native picker: %s', async changed => {
    let claim = true;
    const pending = api.selectModelSettings('gemini-current', null, () => claim);
    await vi.advanceTimersByTimeAsync(200);
    if (changed === 'claim') claim = false;
    if (changed === 'route') dom.window.history.replaceState({}, '', '/u/1/app');
    if (changed === 'editor') { const replacement = box.cloneNode(true); box.replaceWith(replacement); }
    if (changed === 'draft') box.textContent = 'Preserve the human draft and its private key';
    if (changed === 'attachments') nativeAttachment('foreign.txt');
    if (changed === 'generating') document.body.insertAdjacentHTML('beforeend', '<button aria-label="Stop response">Stop</button>');
    const mode = nativeModePicker(), clicked = vi.fn(); mode.picker.addEventListener('click', clicked);
    await vi.advanceTimersByTimeAsync(300); expect(await pending).toBe(false); expect(clicked).not.toHaveBeenCalled();
    expect(mode.clicks).toEqual([]);
    if (changed === 'draft') expect(box.textContent).toBe('Preserve the human draft and its private key');
  });
  it('bounds missing native picker readiness and reports only fixed metadata', async () => {
    box.textContent = 'Private draft must not enter model diagnostics';
    const log = vi.spyOn(dom.window.console, 'info').mockImplementation(() => {});
    let complete = false;
    const pending = api.selectModelSettings('gemini-current', null).then((result: boolean) => { complete = true; return result; });
    await vi.advanceTimersByTimeAsync(4900); expect(complete).toBe(false);
    await vi.advanceTimersByTimeAsync(200); expect(await pending).toBe(false);
    const line = String(log.mock.calls.find(call => String(call[0]).startsWith('[OneCode model] '))![0]);
    expect(JSON.parse(line.slice('[OneCode model] '.length))).toEqual({
      stage: 'picker-not-ready', requestedModel: 'gemini-current', callerCurrent: true, draftCurrent: true, surfaceCurrent: true,
      pickerPresent: false, pickerEnabled: false, pickerReadable: false, nativeGenerating: false,
      menuRows: 0, confirmedChoices: 0, requestedChoiceSelected: false
    });
    expect(line).not.toContain('Private'); expect(line).not.toContain(dom.window.location.href);
  });
  it('returns a bounded model failure reason to the durable delivery owner', async () => {
    const failure = vi.fn();
    const pending = api.selectModelSettings('gemini-current', null, () => true, failure);
    await vi.advanceTimersByTimeAsync(5100);
    expect(await pending).toBe(false);
    expect(failure).toHaveBeenCalledExactlyOnceWith('picker-not-ready');
  });
  it('reads actual native mode IDs/labels and restores the menu without changing selection or offering upsells', async () => {
    const mode = nativeModePicker(); expect(api.visibleModelSelection()).toEqual({ model: 'gemini-current', reasoningEffort: null });
    expect(await api.inspectModelSettings()).toEqual([{ id: 'gemini-current', label: 'Automatic (current Gemini model)', efforts: [] },
      ...nativeModelChoices.map(choice => ({ ...choice, efforts: [] }))]);
    expect(mode.selected()).toBe(nativeModelChoices[1].id); expect(mode.clicks).toEqual([]); expect(document.querySelector('[data-native-models]')).toBeNull();
  });
  it.each(nativeModelChoices)('selects and reopens the menu to prove the real native choice $label', async choice => {
    const mode = nativeModePicker(); const pending = api.selectModelSettings(choice.id, null);
    await vi.advanceTimersByTimeAsync(100); expect(await pending).toBe(true); expect(mode.selected()).toBe(choice.id);
    expect(mode.clicks).toEqual(choice.id === nativeModelChoices[1].id ? [] : [choice.id]); expect(document.querySelector('[data-native-models]')).toBeNull();
  });
  it.each(['attribute', 'glyph', 'disabled'])('excludes a locked valid mode ID from discovery and selection (%s)', async lock => {
    const mode = nativeModePicker();
    mode.picker.addEventListener('click', () => {
      const row = document.querySelector('gem-menu-item[data-mode-id="upsell_MODE_CATEGORY_ULTRA"]');
      if (!row) return;
      row.setAttribute('data-mode-id', '95a4c0abcba24364');
      if (lock === 'glyph') row.querySelector('mat-icon')!.outerHTML = '<gem-icon>lock</gem-icon>';
      if (lock === 'disabled') { row.querySelector('mat-icon')!.remove(); row.setAttribute('aria-disabled', 'true'); }
    });
    const models = await api.inspectModelSettings();
    expect(models?.some((model: any) => model.id === '95a4c0abcba24364')).toBe(false);
    const pending = api.selectModelSettings('95a4c0abcba24364', null);
    await vi.advanceTimersByTimeAsync(6000); expect(await pending).toBe(false);
    expect(mode.clicks).toEqual([]);
  });
  it.each(['upsell', 'selection ignored', 'duplicate ID', 'missing Selected proof', 'changed route', 'changed draft'] as const)(
    'never confirms an unproven native choice: %s', async failure => {
    const mode = nativeModePicker();
    mode.picker.addEventListener('click', () => {
      const rows = document.querySelectorAll('gem-menu-item[data-mode-id]'); if (!rows.length) return;
      if (failure === 'selection ignored') rows[0]!.addEventListener('click', event => event.stopImmediatePropagation(), true);
      if (failure === 'duplicate ID') rows[0]!.after(rows[0]!.cloneNode(true));
      if (failure === 'missing Selected proof') document.querySelector('[aria-label="Selected"]')?.remove();
      if (failure === 'changed route') dom.window.history.replaceState({}, '', '/u/1/app/9c16a67b1d474b59');
      if (failure === 'changed draft') box.textContent = 'Preserve this human draft';
    });
    const pending = api.selectModelSettings(failure === 'upsell' ? 'upsell_MODE_CATEGORY_ULTRA' : nativeModelChoices[0].id, null);
    await vi.advanceTimersByTimeAsync(6000); expect(await pending).toBe(false);
    expect(mode.clicks.some(id => id.startsWith('upsell'))).toBe(false); expect(mode.selected()).toBe(nativeModelChoices[1].id);
    if (failure === 'changed draft') expect(box.textContent).toBe('Preserve this human draft');
  });
});

describe('scoped native Goal continuation sends', () => {
  it.each(['sent', 'authorization refused', 'paused during authorization', 'foreign receipt', 'lost ACK'] as const)(
    'uses the ready token, seals the complete authored draft and reports only its real native receipt: %s', async outcome => {
    const sent: any[] = [], token = 'goal-native-continuation', acceptedId = 'ba53d8ce31d0aabb';
    const reply = 'Continue the exact next step.', prefix = 'Preserved human prefix.';
    let hook: any = null, offered = false, authorized = false, nativeSends = 0, ackAttempts = 0;
    const win: any = dom.window; win.Date.now = () => Date.now();
    const draft = { token, conversationId: id, turnId: 'finished-original', stage: 'ready', reply };
    const claims = vi.spyOn(api, 'setGoalClaim');
    let enabled = true;
    const goal = () => ({ enabled, hasKey: true, own: true, mode: 'goal', objective: 'Finish this scratch task', draft: offered ? draft : null });
    win.CLF_TEST_HOOK = (value: any) => { hook = value; };
    win.chrome = {
      runtime: { id: 'gemini-extension-test', sendMessage: async (message: any) => {
        if (message.type === 'gemini_approval_receipts') return { ok: true, receipts: [] };
        sent.push(message);
        if (message.type === 'status') return { connected: true, paired: true, connectorNames: { core: 'OneCode' } };
        if (message.type === 'activity') return { ok: true, data: { entries: [], nextSince: 0, pendingTools: 0, goal: goal() } };
        if (message.type === 'settings_get') return { ok: true, data: {} };
        if (message.type === 'gemini_binding') {
          expect(message).toMatchObject({ conversation_id: id, goal: { token } });
          expect(message.input).toBeUndefined(); expect(message.opening).toBeUndefined(); expect(message.command).toBeUndefined();
          return { ok: true, data: binding() };
        }
        if (message.type === 'goal_authorize') {
          expect(nativeSends).toBe(0); expect(api.confirmedMention('OneCode')).toBe(true);
          if (outcome === 'paused during authorization') { enabled = false; await hook.pullActivity(); }
          authorized = outcome !== 'authorization refused'; return { ok: true, data: { authorized } };
        }
        if (message.type === 'goal_ack') {
          ackAttempts++;
          if (outcome === 'lost ACK' && ackAttempts === 1) throw new Error('synthetic transport loss');
          offered = false; return { ok: true, data: { acknowledged: true } };
        }
        return { ok: true, pending: 0, durable: true };
      }, onMessage: { addListener() {}, removeListener() {} } },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } }
    };
    nativeStrongMenu();
    document.querySelector('button[aria-label="Send message"]')!.addEventListener('click', () => {
      expect(authorized).toBe(true); nativeSends++;
      const exchange = document.createElement('div'); exchange.className = 'conversation-container'; exchange.id = acceptedId;
      const user = document.createElement('user-query'); const content = document.createElement('div'); content.className = 'query-text';
      content.append(...[...box.cloneNode(true).childNodes]); user.append(content); exchange.append(user); document.querySelector('main')!.append(exchange);
      box.replaceChildren();
      if (outcome === 'foreign receipt') dom.window.history.replaceState({}, '', '/u/1/app/9c16a67b1d474b59');
    });
    win.eval(recorderSource); await vi.advanceTimersByTimeAsync(1000);
    api.insertPrompt(prefix, true);
    offered = true;
    const pending = hook.pullActivity();
    await vi.advanceTimersByTimeAsync(6000); await pending;
    const authorization = sent.find(message => message.type === 'goal_authorize');
    expect(authorization).toMatchObject({ type: 'goal_authorize', conversationId: id, token, text: prefix + reply });
    expect(authorization.text).not.toContain(key); expect(authorization.text).not.toContain('[[GEMINI_LOCAL_SESSION]]');
    expect(nativeSends, JSON.stringify(sent.map(message => ({ type: message.type, error: message.error })))).toBe(outcome === 'sent' || outcome === 'lost ACK' || outcome === 'foreign receipt' ? 1 : 0);
    const acks = sent.filter(message => message.type === 'goal_ack' && message.sent === true);
    if (outcome === 'lost ACK') expect(acks.length).toBeGreaterThanOrEqual(1);
    else expect(acks).toHaveLength(outcome === 'sent' ? 1 : 0);
    if (acks.length) expect(acks[0]).toMatchObject({ type: 'goal_ack', conversationId: id, token, sent: true, messageId: `gemini:${id}:user:${acceptedId}` });
    if (outcome === 'lost ACK') {
      offered = true; await hook.pullActivity();
      expect(nativeSends).toBe(1);
      const repeated = sent.filter(message => message.type === 'goal_ack' && message.sent === true);
      expect(repeated.length).toBeGreaterThan(acks.length);
      expect(repeated.every(message => message.messageId === `gemini:${id}:user:${acceptedId}`)).toBe(true);
      const stored = JSON.parse(win.sessionStorage.getItem('clf-goal-spent-v1'));
      expect(stored).toContainEqual([`${id}\u0000${token}`, `gemini:${id}:user:${acceptedId}`]);
    }
    expect(claims.mock.calls[0]).toEqual([{ token }]);
    expect(claims.mock.calls.at(-1)).toEqual([null]);
  });
});

function approvalExchange() {
  const exchange = document.createElement('div'); exchange.className = 'conversation-container'; exchange.id = '91b9af7227ff18ee';
  const user = document.createElement('user-query'); user.innerHTML = '<div class="query-text">Original accepted task</div>';
  const response = document.createElement('model-response'); response.innerHTML = '<message-content></message-content>';
  const permission = card(); response.append(permission.element); exchange.append(user, response); document.querySelector('main')!.prepend(exchange);
  const reply = (choice = 'Allow', nativeId = 'ba53d8ce31d0aabb') => {
    const container = document.createElement('div'); container.className = 'conversation-container'; container.id = nativeId;
    container.innerHTML = nativeApprovalReply.replaceAll('Allow', choice) + '<model-response><message-content>Native final answer</message-content><div class="response-footer complete"></div></model-response>';
    exchange.after(container); return container;
  };
  const complete = () => { permission.allow.disabled = true; permission.deny.disabled = true; };
  return { exchange, user, response, permission, reply, complete };
}

describe('native approval response rows retain the authored task boundary', () => {
  it('exposes only a bounded, deduplicated metadata audit of the exact decision receipt', () => {
    const flow = approvalExchange();
    api.answerApprovalCard(flow.permission.element, 'allow'); api.messages();
    const waiting = api.approvalAudit(); api.messages();
    expect(api.approvalAudit()).toEqual(waiting);
    expect(waiting).toEqual([
      expect.objectContaining({ stage: 'click', reason: 'registered', sourceId: flow.exchange.id }),
      expect.objectContaining({ stage: 'waiting', reason: 'candidate-absent', candidateId: null })
    ]);
    const clone = api.approvalAudit(); clone[0].reason = 'changed'; expect(api.approvalAudit()).toEqual(waiting);
    flow.complete(); flow.reply(); api.messages();
    expect(api.approvalAudit().at(-1)).toMatchObject({ stage: 'matched', reason: 'completed-control',
      candidateId: 'ba53d8ce31d0aabb', sourceConnected: true, cardConnected: true, sourceMatches: true, routeMatches: true,
      decisionsEnded: true, preexistingNode: false, preexistingId: false, decisionMatches: true });
    expect(JSON.stringify(api.approvalAudit())).not.toMatch(/Original accepted task|session_key|https:|append session note|OneCode/);
    for (let index = 0; index < 21; index++) {
      const next = approvalExchange(); api.answerApprovalCard(next.permission.element, 'allow');
      next.permission.element.replaceWith(next.permission.element.cloneNode(true)); api.messages();
      next.exchange.remove();
    }
    expect(api.approvalAudit()).toHaveLength(20);
    expect(api.approvalAudit().at(-1)).toMatchObject({ stage: 'revoked', reason: 'card-disconnected', cardConnected: false });
  });
  it('diagnoses a decision outside a native source exchange without granting reply suppression', () => {
    const permission = card(); api.answerApprovalCard(permission.element, 'allow');
    expect(api.approvalAudit()).toEqual([expect.objectContaining({ stage: 'untracked', reason: 'missing-native-source',
      sourceId: null, sourceConnected: false, sourceMatches: false })]);
    turn('user', 'Allow', 'ordinary-allow');
    expect(api.messages().filter((message: any) => message.role === 'user').map((message: any) => message.text)).toEqual(['Allow']);
  });
  it.each(['allow', 'deny'])('excludes only the resulting native %s exchange after its exact decision click', choice => {
    const flow = approvalExchange(); flow.permission[choice as 'allow' | 'deny'].addEventListener('click', () => { flow.complete(); flow.reply(choice === 'allow' ? 'Allow' : 'Deny'); });
    expect(api.answerApprovalCard(flow.permission.element, choice)).toBe('clicked');
    expect(api.messages().filter((row: any) => row.role === 'user').map((row: any) => row.text)).toEqual(['Original accepted task']);
    expect(api.messages().at(-1).text).toBe('Native final answer');
    expect(api.turnIdOf(flow.exchange.nextElementSibling!.querySelector('user-query'))).toBeNull();
  });
  it('retains an ordinary authored Allow next to a historical disabled permission card', () => {
    const flow = approvalExchange(); flow.complete(); flow.reply();
    expect(api.messages().filter((row: any) => row.role === 'user').map((row: any) => row.text)).toEqual(['Original accepted task', 'Allow']);
  });
  it('retains exact click receipts across an adapter reload without hiding another authored Allow', async () => {
    const flow = approvalExchange(); let stored: any[] = [];
    const store = vi.fn(async (request: any) => { if (request.receipts) stored = structuredClone(request.receipts); return structuredClone(stored); });
    api.setApprovalReceiptStore(store); expect(api.approvalReceiptsReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(api.approvalReceiptsReady()).toBe(true);
    api.answerApprovalCard(flow.permission.element, 'allow'); flow.complete(); flow.reply(); api.messages();
    expect(await api.flushApprovalReceipts()).toBe(true);
    expect(stored).toEqual([{ sourceId: flow.exchange.id, replyId: 'ba53d8ce31d0aabb', decision: 'Allow' }]);
    dom.window.eval(source); api = (dom.window as any).CLF_DOM; api.setApprovalReceiptStore(store);
    expect(api.approvalReceiptsReady()).toBe(false); await vi.advanceTimersByTimeAsync(1);
    expect(api.approvalReceiptsReady()).toBe(true);
    expect(api.messages().filter((row: any) => row.role === 'user').map((row: any) => row.text)).toEqual(['Original accepted task']);
    flow.reply('Allow', 'aa53d8ce31d0aabb');
    expect(api.messages().filter((row: any) => row.role === 'user').map((row: any) => row.text)).toEqual(['Original accepted task', 'Allow']);
  });
  it('keeps receipt restoration pending on storage failure and refuses a receipt for changed text', async () => {
    const flow = approvalExchange(); flow.complete(); flow.reply('My real next task');
    const store = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue([
      { sourceId: flow.exchange.id, replyId: 'ba53d8ce31d0aabb', decision: 'Allow' }
    ]);
    api.setApprovalReceiptStore(store); expect(api.approvalReceiptsReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(api.approvalReceiptsReady()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(api.approvalReceiptsReady()).toBe(true);
    expect(api.messages().filter((row: any) => row.role === 'user').map((row: any) => row.text)).toEqual(['Original accepted task', 'My real next task']);
    dom.window.history.replaceState({}, '', `/u/1/app/${id}`);
    expect(api.approvalReceiptsReady()).toBe(false);
  });
  it('holds a matching decision row while its clicked native card finishes, without creating a provisional authored turn', () => {
    const flow = approvalExchange(); flow.permission.allow.addEventListener('click', () => flow.reply());
    api.answerApprovalCard(flow.permission.element, 'allow');
    expect(api.messages().filter((row: any) => row.role === 'user')).toHaveLength(1);
    flow.complete(); expect(api.messages().filter((row: any) => row.role === 'user')).toHaveLength(1);
  });
  it.each(['allow', 'deny'])('retains an observed completed %s receipt after Gemini removes its card, until the exact new native reply hydrates', choice => {
    const flow = approvalExchange(); api.answerApprovalCard(flow.permission.element, choice);
    flow.complete(); api.messages(); // The actual audit observed both original decisions ended while mounted.
    flow.permission.element.remove(); api.messages();
    const reply = flow.reply(choice === 'allow' ? 'Allow' : 'Deny', 'undefined');
    expect(api.messages().filter((row: any) => row.role === 'user').map((row: any) => row.text)).toEqual(['Original accepted task']);
    reply.id = 'ba53d8ce31d0aabb';
    for (let observation = 0; observation < 3; observation++) {
      expect(api.messages().filter((row: any) => row.role === 'user').map((row: any) => row.text)).toEqual(['Original accepted task']);
    }
    expect(api.approvalAudit().filter((row: any) => row.stage === 'matched')).toEqual([
      expect.objectContaining({ reason: 'completed-control', sourceId: flow.exchange.id, candidateId: reply.id,
        sourceConnected: true, cardConnected: false, routeMatches: true, decisionMatches: true })
    ]);
  });
  it.each(['allow', 'deny'])('retains exact %s completion and removal in one native render transaction', async choice => {
    const flow = approvalExchange(); api.answerApprovalCard(flow.permission.element, choice);
    flow.complete(); flow.permission.element.remove();
    // Include the microtask-delivered observer path as well as takeRecords().
    if (choice === 'deny') await Promise.resolve();
    flow.reply(choice === 'allow' ? 'Allow' : 'Deny');
    expect(api.messages().filter((row: any) => row.role === 'user').map((row: any) => row.text)).toEqual(['Original accepted task']);
    expect(api.approvalAudit().at(-1)).toMatchObject({ stage: 'matched', reason: 'completed-control', cardConnected: false });
  });
  it.each(['completion after removal', 'unfinished removal', 'source removed', 'source ID changed', 'route changed',
    'reparented card', 'new card', 'controls replaced', 'decisions reopened', 'foreign text'])(
    'keeps the candidate authored when the exact completed decision lifecycle is not retained: %s', mode => {
      const flow = approvalExchange(); api.answerApprovalCard(flow.permission.element, 'allow');
      if (!['completion after removal', 'unfinished removal', 'new card'].includes(mode)) { flow.complete(); api.messages(); }
      if (mode === 'completion after removal') { flow.permission.element.remove(); flow.complete(); }
      if (mode === 'unfinished removal') flow.permission.element.remove();
      if (mode === 'source removed') flow.exchange.remove();
      if (mode === 'source ID changed') flow.exchange.id = 'aa53d8ce31d0aabb';
      if (mode === 'route changed') dom.window.history.replaceState({}, '', `/app/${id}?changed=1`);
      if (mode === 'reparented card') {
        const foreign = document.createElement('div'); foreign.className = 'conversation-container'; foreign.id = 'aa53d8ce31d0aabb';
        document.querySelector('main')!.append(foreign); foreign.append(flow.permission.element);
      }
      if (mode === 'new card') {
        const replacement = flow.permission.element.cloneNode(true) as HTMLElement;
        replacement.querySelectorAll('button').forEach(button => { button.disabled = true; });
        flow.permission.element.replaceWith(replacement);
      }
      if (mode === 'controls replaced') for (const button of [flow.permission.allow, flow.permission.deny]) button.replaceWith(button.cloneNode(true));
      if (mode === 'decisions reopened') { flow.permission.allow.disabled = false; flow.permission.deny.disabled = false; }
      if (mode === 'foreign text') flow.permission.element.remove();
      const reply = flow.reply(mode === 'foreign text' ? 'A genuine new task' : 'Allow');
      if (mode === 'source removed') document.querySelector('main')!.append(reply);
      expect(api.messages().filter((row: any) => row.role === 'user').map((row: any) => row.text)).toContain(mode === 'foreign text' ? 'A genuine new task' : 'Allow');
      expect(api.approvalAudit().some((row: any) => row.stage === 'matched')).toBe(false);
    });
  it('keeps the original click deadline after observing completion and later card removal', async () => {
    const flow = approvalExchange(); api.answerApprovalCard(flow.permission.element, 'allow');
    flow.complete(); api.messages(); flow.permission.element.remove();
    await vi.advanceTimersByTimeAsync(30001); flow.reply();
    expect(api.messages().filter((row: any) => row.role === 'user').map((row: any) => row.text)).toEqual(['Original accepted task', 'Allow']);
    expect(api.approvalAudit().at(-1)).toMatchObject({ stage: 'revoked', reason: 'expired' });
  });
  it('waits for a native approval reply ID to hydrate before consuming its exact click receipt', () => {
    const flow = approvalExchange(); let reply: HTMLElement | null = null;
    flow.permission.allow.addEventListener('click', () => { flow.complete(); reply = flow.reply('Allow', 'undefined'); });
    expect(api.answerApprovalCard(flow.permission.element, 'allow')).toBe('clicked');
    expect(api.messages().filter((row: any) => row.role === 'user').map((row: any) => row.text)).toEqual(['Original accepted task']);
    reply!.id = 'ba53d8ce31d0aabb';
    expect(api.messages().filter((row: any) => row.role === 'user').map((row: any) => row.text)).toEqual(['Original accepted task']);
    expect(api.turnIdOf(reply!.querySelector('user-query'))).toBeNull();
  });
  it('preserves an already present authored Allow whose native ID hydrates after a later permission click', () => {
    const flow = approvalExchange(), authoredReply = flow.reply('Allow', 'undefined');
    api.answerApprovalCard(flow.permission.element, 'allow'); flow.complete();
    expect(api.messages().filter((row: any) => row.role === 'user')).toHaveLength(1);
    authoredReply.id = 'ba53d8ce31d0aabb';
    expect(api.messages().filter((row: any) => row.role === 'user').map((row: any) => row.text)).toEqual(['Original accepted task', 'Allow']);
  });
  it.each(['trusted edit', 'navigation', 'card replaced', 'expired', 'different text'])('preserves an unproven authored row after %s', async mode => {
    const flow = approvalExchange(), listeners = vi.spyOn(document, 'addEventListener');
    api.answerApprovalCard(flow.permission.element, 'allow');
    if (mode === 'trusted edit') {
      const listener = listeners.mock.calls.find(call => call[0] === 'beforeinput' && (call[1] as Function).name === 'noteApprovalReplyEdit')![1] as EventListener;
      listener({ isTrusted: true, target: box } as unknown as Event);
    }
    if (mode === 'navigation') dom.window.history.replaceState({}, '', `/app/${id}?different-view=1`);
    if (mode === 'card replaced') flow.permission.element.replaceWith(flow.permission.element.cloneNode(true));
    if (mode === 'expired') await vi.advanceTimersByTimeAsync(30001);
    flow.complete(); flow.reply(mode === 'different text' ? 'A genuine new task' : 'Allow');
    expect(api.messages().filter((row: any) => row.role === 'user')).toHaveLength(2);
  });
  it('preserves native code block semantics through the actual Markdown helper composition', () => {
    dom.window.eval(markdownSource);
    const response = turn('assistant', '', 'native-code');
    response.querySelector('message-content')!.innerHTML = '<p>Exact graph:</p><code-block><div class="formatted-code-block-internal-container"><div class="code-block-decoration"><span>JSON</span><button>Copy code</button></div><pre><code data-test-id="code-content">{"entities":[],"relations":[]}</code></pre></div></code-block>';
    const text = api.messages()[0].text;
    expect(text).toContain('```json\n{"entities":[],"relations":[]}\n```');
    expect(text).not.toContain('Copy code');
  });
  it('keeps a genuine app-authored Allow after an earlier permission click as a new message', async () => {
    const flow = approvalExchange(); api.answerApprovalCard(flow.permission.element, 'allow'); flow.complete();
    api.insertPrompt('Allow', true); api.setBindingResolver(async () => binding()); nativeStrongMenu();
    document.querySelector('button[aria-label="Send message"]')!.addEventListener('click', () => {
      const row = flow.reply(); row.querySelector('.query-text')!.replaceChildren(...[...box.cloneNode(true).childNodes]); box.replaceChildren();
    });
    const pending = api.send(); await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBe(true);
    expect(api.messages().filter((row: any) => row.role === 'user').map((row: any) => row.text)).toEqual(['Original accepted task', 'Allow']);
  });
  it('keeps two native parallel approval replies inside the same original authored task', async () => {
    const flow = approvalExchange(), second = card(); flow.response.append(second.element);
    let first: HTMLElement | null = null;
    flow.permission.allow.addEventListener('click', () => { flow.complete(); first = flow.reply(); });
    second.allow.addEventListener('click', () => {
      second.allow.disabled = true; second.deny.disabled = true;
      const row = flow.reply('Allow', 'aa53d8ce31d0aabb'); if (first) first.after(row);
    });
    api.setBindingResolver(async () => binding());
    expect(await api.maybeAutoApprove()).toBe(true);
    expect(api.messages().filter((row: any) => row.role === 'user').map((row: any) => row.text)).toEqual(['Original accepted task']);
    expect(document.querySelectorAll('user-query')).toHaveLength(3);
  });
});

describe('Gemini native identity and recording', () => {
  it.each(['', 'undefined', '0'])('withholds hydrated shell IDs until the real native exchange appears (%s)', placeholder => {
    const container = document.createElement('div'); container.className = 'conversation-container'; container.id = placeholder;
    container.innerHTML = '<user-query><div class="query-text" id="user-query-content-undefined">Actual submitted task</div></user-query>' +
      '<model-response><message-content id="message-content-id-undefined">Actual final answer</message-content><div class="response-footer complete"></div></model-response>';
    document.querySelector('main')!.append(container);
    expect(api.messages()).toEqual([]); expect(api.turns()).toEqual([]); expect(api.turnIdOf(container.querySelector('user-query'))).toBeNull();
    container.id = '4c9572492c5bc90b';
    expect(api.messages()).toEqual([
      expect.objectContaining({ id: `gemini:${id}:user:4c9572492c5bc90b`, text: 'Actual submitted task' }),
      expect.objectContaining({ id: `gemini:${id}:assistant:4c9572492c5bc90b`, text: 'Actual final answer' })
    ]);
  });
  it('accepts only an exact Gemini app conversation path', () => {
    expect(api.conversationId()).toBe(id);
    expect(api.conversationFromPath('/app/EA972BA88CC341C6')).toBe(id);
    expect(api.conversationFromPath('/u/0/app/EA972BA88CC341C6')).toBe(id);
    expect(api.conversationFromPath('/u/12/app/' + id + '/')).toBe(id);
    for (const path of ['/app', '/app/ea972ba88cc341c6/foreign', '/share/ea972ba88cc341c6', '/c/ea972ba88cc341c6', '/app/1234', '/u/0/app', '/u/abc/app/' + id, '/u/-1/app/' + id, '/u/0/app/' + id + '/foreign'])
      expect(api.conversationFromPath(path)).toBeNull();
  });
  it('recognizes only native app-home routes and an observed same-origin New chat link', async () => {
    for (const path of ['/app', '/app/', '/u/0/app', '/u/12/app/']) expect(api.isAppHomePath(path)).toBe(true);
    for (const path of ['/u/abc/app', '/share', '/u/0/app/' + id, '/app/foreign']) expect(api.isAppHomePath(path)).toBe(false);
    const foreign = document.createElement('a'); foreign.href = 'https://evil.invalid/u/0/app'; foreign.ariaLabel = 'New chat'; document.body.append(foreign);
    expect(await api.newChatControl()).toBeNull();
    const own = document.createElement('a'); own.href = '/u/0/app'; own.ariaLabel = 'New chat'; document.body.append(own);
    expect(await api.newChatControl()).toBe(own);
  });
  it('strips app control credentials from transcript and receipts without mutating native content', () => {
    const user = turn('user', 'Read the scratch journal.' + frame, 'query-one');
    expect(api.messages()).toEqual([expect.objectContaining({ id: `gemini:${id}:user:query-one`, role: 'user', text: 'Read the scratch journal.' })]);
    expect(user.textContent).toContain(key);
    expect(api.userPromptText('Read the scratch journal.' + frame)).toBeNull();
  });
  it('removes only the native hidden user-query accessibility duplicate, retaining ordinary headings', () => {
    const user = turn('user', '', 'native-hidden-label');
    const content = user.querySelector('.query-text')!;
    const label = document.createElement('h5'); label.className = 'cdk-visually-hidden screen-reader-user-query-label';
    label.innerHTML = '<span>You said</span> Truncated task…';
    const heading = document.createElement('h5'); heading.textContent = 'Authored heading';
    const visible = document.createElement('p'); visible.className = 'query-text-line'; visible.textContent = 'Complete native task.' + frame;
    content.append(label, heading, visible);
    expect(api.messages()[0].text).toBe('Authored heading\nComplete native task.');
    expect(label.isConnected).toBe(true); expect(user.textContent).toContain('You said'); expect(user.textContent).toContain(key);
  });
  it('keeps a prepared draft valid while only its own control metadata is appended', () => {
    api.insertPrompt('Exact task', true);
    const lease = api.captureComposerDraft('Exact task');
    api.insertPrompt('Exact task' + frame, true);
    expect(lease.current()).toBe(true);
    box.textContent = 'Human replacement';
    expect(lease.current()).toBe(false);
    expect(api.clearPromptExact('Exact task')).toBe(false);
    expect(box.textContent).toBe('Human replacement');
  });
  it('does not record the controlled warm-up exchange as the user task', () => {
    const warm = turn('user', warmup, 'warm');
    const response = document.createElement('model-response'); response.id = 'ready'; response.textContent = 'READY'; warm.after(response);
    const real = document.createElement('user-query'); real.id = 'task'; real.innerHTML = '<div class="query-text">Real task</div>'; response.after(real);
    expect(api.messages().map((row: any) => row.text)).toEqual(['Real task']);
  });
  it('preserves paragraph and code boundaries in a long native message', () => {
    const user = turn('user', '', 'multiline');
    user.querySelector('.query-text')!.innerHTML = '<p>First instruction.</p><p>Second instruction.</p><pre><code>const a = 1;\nconst b = 2;</code></pre>';
    expect(api.messages()[0].text).toBe('First instruction.\nSecond instruction.\nconst a = 1;\nconst b = 2;');
  });
  it('keeps the native exchange identity when user-query indexes change after a remount', () => {
    const exchange = document.createElement('div'); exchange.className = 'conversation-container'; exchange.id = '72dc3243100aa9d7';
    exchange.innerHTML = '<user-query><div id="user-query-content-13" class="query-text">Stable question</div></user-query><model-response><message-content id="message-content-id-r_72dc3243100aa9d7">Stable answer</message-content></model-response>';
    document.querySelector('main')!.prepend(exchange);
    const before = api.messages().map((row: any) => row.id);
    exchange.querySelector('user-query')!.outerHTML = '<user-query><div id="user-query-content-2" class="query-text">Stable question</div></user-query>';
    expect(api.messages().map((row: any) => row.id)).toEqual(before);
    expect(before).toEqual([`gemini:${id}:user:72dc3243100aa9d7`, `gemini:${id}:assistant:72dc3243100aa9d7`]);
  });
  it('accepts the observed long Quill paragraph shape and preserves exact context-frame lengths', () => {
    const context = Array.from({ length: 166 }, (_, at) => at % 3 === 2 ? '' :
      `Generated instruction ${at}: preserve exact quoted code, paths, whitespace and receipt boundaries. ${'Fixture context. '.repeat(9)}`).join('\n');
    const task = 'Read the scratch workspace and report a durable result.';
    const prepared = `[[COS_CONTEXT:${context.length}]]\n${context}\n[[/COS_CONTEXT]]\n\n${task}`;
    expect(prepared.length).toBeGreaterThan(21000);
    document.execCommand = (command, _ui, value) => {
      if (command !== 'insertText') return false;
      box.replaceChildren(...String(value || '').split('\n').map(line => {
        const paragraph = document.createElement('p');
        if (line) paragraph.textContent = line; else paragraph.append(document.createElement('br'));
        return paragraph;
      }));
      return true;
    };
    expect(api.insertPrompt(prepared, true)).toBe(true);
    expect(api.composerAuthoredText()).toBe(prepared);
    expect(api.userPromptText(api.composerAuthoredText())).toBe(task);
    expect(box.textContent).not.toBe(prepared); // Quill's DOM textContent drops line boundaries.
  });
});

describe('native approval policy and execution evidence', () => {
  it('parses the captured connector header/body layout and autoapproves an enabled machine apply_patch tool', async () => {
    const pending = card('apply patch', 'OneCode Core');
    const details = document.createElement('div'); details.dataset.testId = 'collapsed-details';
    details.innerHTML = '<div data-test-id="detail-row"><div data-test-id="detail-body"><b>Tool: </b>apply_patch</div></div>';
    pending.element.querySelector('[data-test-id="body"]')!.append(details);
    const click = vi.spyOn(pending.allow, 'click');
    api.setBindingResolver(async () => binding({ connector_name: 'OneCode Core', connector_names: ['OneCode Core'],
      enabled_tools_by_connector: { 'OneCode Core': ['apply_patch'] } }));
    expect(api.approvalCard()).toMatchObject({ connector: 'OneCode Core', tool: 'apply patch', machineTool: 'apply_patch' });
    expect(await api.maybeAutoApprove()).toBe(true); expect(click).toHaveBeenCalledTimes(1);
  });
  it('refuses a permission sentence whose connector disagrees with its native header', async () => {
    const pending = card('apply patch', 'Other App');
    pending.element.querySelector('[data-test-id="body"] > p')!.textContent = 'Let Gemini use "apply patch" from OneCode';
    const click = vi.spyOn(pending.allow, 'click'); api.setBindingResolver(async () => binding({ enabled_tools: ['apply_patch', 'apply patch'] }));
    expect(api.approvalCard()).toBeNull(); expect(api.approvalWaiting()).toBe(true);
    expect(await api.maybeAutoApprove()).toBe(false); expect(click).not.toHaveBeenCalled();
  });
  it('clicks Allow once only for the configured connector and enabled tool', async () => {
    const { element, allow } = card();
    const click = vi.spyOn(allow, 'click');
    api.setBindingResolver(async () => binding());
    expect(await api.maybeAutoApprove()).toBe(true);
    expect(await api.maybeAutoApprove()).toBe(false);
    expect(click).toHaveBeenCalledTimes(1);
    expect(api.approvalWaiting()).toBe(true); // A click is not execution or card disappearance.
    expect(api.approvalObservations()).toEqual([expect.objectContaining({ tool: 'append session note', outcome: 'clicked' })]);
    expect(api.answerApprovalCard(element, 'allow')).toBe('unavailable');
  });
  it.each([
    ['another connector', {}, 'Other App'],
    ['disabled tool', { enabled_tools: ['read journal'] }, 'OneCode'],
    ['disabled policy', { auto_approve: false }, 'OneCode'],
    ['foreign conversation', { conversation_id: '9c16a67b1d474b59' }, 'OneCode']
  ])('leaves %s pending', async (_name, overrides, connector) => {
    const { allow } = card('append session note', connector as string);
    const click = vi.spyOn(allow, 'click');
    api.setBindingResolver(async () => binding(overrides as any));
    expect(await api.maybeAutoApprove()).toBe(false);
    expect(click).not.toHaveBeenCalled();
  });
  it('rejects an old card after policy lookup races with a replacement card', async () => {
    const old = card(); const clicked = vi.spyOn(old.allow, 'click');
    let resolve: (value: any) => void = () => {};
    api.setBindingResolver(() => new Promise(done => { resolve = done; }));
    const pending = api.maybeAutoApprove(); old.element.remove(); const replacement = card();
    const replacementClick = vi.spyOn(replacement.allow, 'click'); resolve(binding());
    expect(await pending).toBe(false);
    expect(clicked).not.toHaveBeenCalled(); expect(replacementClick).not.toHaveBeenCalled();
  });
  it('autoapproves each enabled own parallel card while leaving the manual card selector ambiguous', async () => {
    const first = card(), second = card(); api.setBindingResolver(async () => binding());
    const clicks = [vi.spyOn(first.allow, 'click'), vi.spyOn(second.allow, 'click')];
    expect(api.approvalCard()).toBeNull();
    expect(await api.maybeAutoApprove()).toBe(true);
    for (const click of clicks) expect(click).toHaveBeenCalledTimes(1);
    expect(await api.maybeAutoApprove()).toBe(false);
    expect(api.approvalWaiting()).toBe(true);
    expect(api.generating()).toBe(true);
  });
  it('does not borrow permission between surfaces while approving mixed parallel cards', async () => {
    const core = card('exec'), desktop = card('exec', 'OneCode Desktop'), foreign = card('exec', 'Other App');
    const coreClick = vi.spyOn(core.allow, 'click'), desktopClick = vi.spyOn(desktop.allow, 'click'), foreignClick = vi.spyOn(foreign.allow, 'click');
    api.setBindingResolver(async () => binding({ connector_names: ['OneCode', 'OneCode Desktop'],
      enabled_tools_by_connector: { 'OneCode': ['exec'], 'OneCode Desktop': ['read'] } }));
    expect(await api.maybeAutoApprove()).toBe(true);
    expect(coreClick).toHaveBeenCalledTimes(1); expect(desktopClick).not.toHaveBeenCalled(); expect(foreignClick).not.toHaveBeenCalled();
  });
  it('ignores completed historical cards with enabled Expand text when preparing the next message', () => {
    const response = document.createElement('model-response'); response.innerHTML = '<message-content>Old answer</message-content><div class="response-footer complete"></div>';
    document.querySelector('main')!.append(response);
    for (let index = 0; index < 6; index++) {
      const historical = card('append session note', 'Gemini Session Routing Probe');
      historical.allow.disabled = true; historical.deny.disabled = true;
      const expand = document.createElement('button'); expand.setAttribute('aria-label', 'Expand text'); historical.element.append(expand);
      response.append(historical.element);
    }
    expect(api.approvalCard()).toBeNull(); expect(api.approvalWaiting()).toBe(false); expect(api.generating()).toBe(false);
    expect(api.messageComplete({ node: response })).toBe(true);
    expect(api.composerSubmitReady()).toBe(true);
    expect(api.insertPrompt('Read the next scratch file', true)).toBe(true);
    expect(api.composerAuthoredText()).toBe('Read the next scratch file');
  });
  it('keeps a real pending card waiting when Allow is unavailable but Deny is enabled', async () => {
    const pending = card(); pending.allow.disabled = true;
    const click = vi.spyOn(pending.allow, 'click'); api.setBindingResolver(async () => binding());
    expect(api.approvalCard()?.allow).toBe(false); expect(api.approvalWaiting()).toBe(true); expect(api.generating()).toBe(true);
    expect(await api.maybeAutoApprove()).toBe(false); expect(click).not.toHaveBeenCalled();
  });
  it('uses the native card machine tool name when its display title is different', async () => {
    const { element, allow } = card('Execute a local action');
    const details = document.createElement('div'); details.dataset.testId = 'body'; details.textContent = 'Tool: exec'; element.append(details);
    const click = vi.spyOn(allow, 'click');
    api.setBindingResolver(async () => binding({ enabled_tools: ['exec'] }));
    expect(await api.maybeAutoApprove()).toBe(true); expect(click).toHaveBeenCalledTimes(1);
  });
  it('approves an enabled Desktop tool using its own connector policy', async () => {
    const { allow } = card('Run JavaScript', 'OneCode Desktop'); const click = vi.spyOn(allow, 'click');
    api.setBindingResolver(async () => binding({ connector_names: ['OneCode', 'OneCode Desktop'],
      enabled_tools_by_connector: { 'OneCode': ['append session note'], 'OneCode Desktop': ['Run JavaScript'] } }));
    expect(await api.maybeAutoApprove()).toBe(true); expect(click).toHaveBeenCalledTimes(1);
  });
  it('does not borrow Core tool permission to approve a disabled Desktop tool', async () => {
    const { allow } = card('Run JavaScript', 'OneCode Desktop'); const click = vi.spyOn(allow, 'click');
    api.setBindingResolver(async () => binding({ connector_names: ['OneCode', 'OneCode Desktop'], enabled_tools: ['Run JavaScript'],
      enabled_tools_by_connector: { 'OneCode': ['Run JavaScript'], 'OneCode Desktop': [] } }));
    expect(await api.maybeAutoApprove()).toBe(false); expect(click).not.toHaveBeenCalled();
  });
});

describe('one Send and native acceptance', () => {
  it.each(['foreign-task', 'changed-route', 'expired-lifetime', 'changed-attachments', 'trusted-edit'] as const)(
    'does not rebind a worker editor after %s, even with an existing draft lease', async mode => {
    dom.window.history.replaceState({}, '', '/app?clf=1234567890abcdef');
    const task = 'Exact scratch worker bootstrap'; api.insertPrompt(task, true);
    api.setCommandClaim({ id: '1234567890abcdef', client: 'original-client' });
    const button = document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement; button.disabled = true;
    let alive = true;
    const lease = api.captureComposerDraft(task, () => alive), rebind = vi.spyOn(lease, 'rebind'), authorize = vi.fn(() => true), clicked = vi.spyOn(button, 'click');
    const listeners = vi.spyOn(document, 'addEventListener');
    vi.spyOn(dom.window.console, 'info').mockImplementation(() => {});
    const pending = api.send({ initialDraft: lease, beforeSend: authorize, stillCurrent: () => alive });
    const replacement = box.cloneNode(true) as HTMLElement;
    if (mode === 'foreign-task') replacement.textContent = 'Human replacement task';
    if (mode === 'changed-route') dom.window.history.replaceState({}, '', '/app?clf=fedcba0987654321');
    if (mode === 'expired-lifetime') alive = false;
    if (mode === 'changed-attachments') {
      nativeAttachment('human.txt', button.parentElement!);
    }
    box.replaceWith(replacement);
    if (mode === 'trusted-edit') {
      const listener = listeners.mock.calls.find(call => call[0] === 'input' && (call[1] as Function)?.name === 'noteInitialEdit')?.[1] as EventListener;
      expect(listener).toBeDefined(); listener({ isTrusted: true, target: replacement } as unknown as Event);
    }
    button.disabled = false; await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toBe(false); expect(rebind).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled(); expect(clicked).not.toHaveBeenCalled();
    expect(replacement.textContent).toBe(mode === 'foreign-task' ? 'Human replacement task' : task);
  });
  it('diagnoses replacement of an exact worker draft during initial Send readiness without spending a grant', async () => {
    const task = 'Private worker task must retain its exact editor owner';
    api.insertPrompt(task, true);
    api.setCommandClaim({ id: '1234567890abcdef', client: 'private-original-client' });
    const button = document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
    button.disabled = true;
    const lease = api.captureComposerDraft(task), authorize = vi.fn(() => true), clicked = vi.spyOn(button, 'click');
    const diagnostic = vi.spyOn(dom.window.console, 'info').mockImplementation(() => {});
    const why: string[] = [], pending = api.send({ beforeSend: authorize, stillCurrent: () => lease.current(), explain: (reason: string) => why.push(reason) });
    const replacement = box.cloneNode(true) as HTMLElement; box.replaceWith(replacement);
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toBe(false); expect(why).toEqual(['send-not-ready']);
    expect(authorize).not.toHaveBeenCalled(); expect(clicked).not.toHaveBeenCalled();
    expect(replacement.textContent).toBe(task);
    const line = String(diagnostic.mock.calls[0]?.[0]);
    expect(JSON.parse(line.slice('[OneCode initial Send] '.length))).toMatchObject({
      callerCurrent: false, editorSame: false, editorConnected: false, routeMatches: true, authoredMatches: true,
      readyObserved: false, sendPresent: true, sendEnabled: false, commandPresent: true, openingPresent: false
    });
    expect(line).not.toContain(task); expect(line).not.toContain('private-original-client'); expect(line).not.toContain(key);
  });
  it('does not treat ordinary leading strong text as an app mention', () => {
    box.innerHTML = '<p><strong>@OneCode</strong> ordinary bold text</p>';
    expect(api.confirmedMention('OneCode')).toBe(false);
    expect(api.composerAuthoredText()).toBe('@OneCode ordinary bold text');
  });
  it('preserves a proven native strong mention through an authorized draft replacement', async () => {
    api.insertPrompt('Original task', true); nativeStrongMenu();
    expect(await api.selectConnector('OneCode', () => true)).toBe(true);
    const strong = box.querySelector('strong');
    expect(api.composerAuthoredText()).toBe('Original task');
    expect(api.insertPrompt('Replacement task', true)).toBe(true);
    expect(box.querySelector('strong')).toBe(strong);
    expect(api.composerAuthoredText()).toBe('Replacement task');
    expect(api.confirmedMention('OneCode')).toBe(true);
    dom.window.history.replaceState({}, '', '/app/9c16a67b1d474b59');
    expect(api.confirmedMention('OneCode')).toBe(false);
  });
  it('keeps an exact draft lease through empty-composer native menu selection and restores the task before authorization', async () => {
    api.insertPrompt('Exact long task\nwith its second paragraph', true); nativeStrongMenu();
    const lease = api.captureComposerDraft('Exact long task\nwith its second paragraph');
    const edit = document.execCommand;
    document.execCommand = (command, ui, value) => {
      if (value === '@') { expect(box.innerHTML).toBe('<p><br></p>'); expect(box.textContent).toBe(''); }
      return edit(command, ui, value);
    };
    expect(await api.selectConnector('OneCode', () => lease.current())).toBe(true);
    expect(lease.current()).toBe(true);
    expect(api.composerAuthoredText()).toBe('Exact long task\nwith its second paragraph');
  });
  it('waits for native empty paragraph/caret before @ when nonempty replacement and an unsettled empty edit cannot open the menu', async () => {
    api.insertPrompt('Original task', true);
    const lease = api.captureComposerDraft('Original task'), edit = document.execCommand;
    let emptyUnsettled = false, emptySettled = false;
    const edits: Array<{ value: string; selected: string }> = [];
    document.execCommand = (command, ui, value) => {
      edits.push({ value: value || '', selected: document.getSelection()?.toString() || '' });
      if (!value) {
        // native-selector-sequence.json: clear succeeds, leaves an unsettled
        // <p></p>; immediate @ has DIV/0 caret and is rejected without mutation.
        box.innerHTML = '<p></p>'; emptyUnsettled = true;
        (document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).disabled = true;
        setTimeout(() => {
          emptyUnsettled = false; emptySettled = true;
          if (!box.textContent) {
            box.innerHTML = '<p><br></p>';
            const caret = document.createRange(); caret.setStart(box.firstElementChild!, 0); caret.collapse(true);
            const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(caret);
          }
        }, 50);
        return true;
      }
      if (value === '@' && emptyUnsettled) return false;
      const done = edit(command, ui, value);
      if (value === '@' && done && emptySettled) renderStrongMenu();
      return done;
    };
    const pending = api.selectConnector('OneCode', () => lease.current());
    await vi.advanceTimersByTimeAsync(25);
    expect(edits).toEqual([{ value: '', selected: 'Original task' }]);
    expect(lease.current()).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toBe(true);
    expect(edits).toEqual([{ value: '', selected: 'Original task' }, { value: '@', selected: '' }, { value: ' Original task', selected: ' ' }]);
    expect(api.confirmedMention('OneCode')).toBe(true);
    expect(api.composerAuthoredText()).toBe('Original task'); expect(lease.current()).toBe(true);
  });
  it('uses the actual normalized empty UI while our clearing selection remains DIV/0 to DIV/1, then establishes P/0 caret', async () => {
    api.insertPrompt('Original task', true);
    const lease = api.captureComposerDraft('Original task'), edit = document.execCommand;
    let restoredCaret = false;
    const addRange = document.getSelection()!.addRange.bind(document.getSelection());
    vi.spyOn(document.getSelection()!, 'addRange').mockImplementation(range => {
      if (range.collapsed && range.startContainer.nodeName === 'P' && range.startOffset === 0) restoredCaret = true;
      return addRange(range);
    });
    document.execCommand = (command, ui, value) => {
      if (!value) {
        box.innerHTML = '<p></p>';
        (document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).disabled = true;
        setTimeout(() => {
          box.innerHTML = '<p><br></p>';
          const range = document.createRange(); range.selectNodeContents(box);
          const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
          expect(selection.anchorNode).toBe(box); expect(selection.anchorOffset).toBe(0);
          expect(selection.focusNode).toBe(box); expect(selection.focusOffset).toBe(1); expect(selection.isCollapsed).toBe(false);
          expect(restoredCaret).toBe(false);
        }, 50);
        return true;
      }
      if (value === '@') expect(restoredCaret).toBe(true);
      const done = edit(command, ui, value);
      if (value === '@' && done) renderStrongMenu();
      return done;
    };
    const pending = api.selectConnector('OneCode', () => lease.current());
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toBe(true); expect(restoredCaret).toBe(true);
    expect(api.confirmedMention('OneCode')).toBe(true); expect(lease.current()).toBe(true);
    expect(api.composerAuthoredText()).toBe('Original task');
  });
  it.each([true, false])('waits for the same native bold token to normalize after restoring the task: normalize=%s', async normalize => {
    api.insertPrompt('Original task', true); nativeStrongMenu();
    const lease = api.captureComposerDraft('Original task'), edit = document.execCommand;
    let originalStrong: HTMLElement | null = null;
    document.execCommand = (command, ui, value) => {
      if (value === ' Original task' && box.querySelector('strong')) {
        originalStrong = box.querySelector('strong');
        originalStrong!.textContent = '@OneCode Original task';
        for (const sibling of [...originalStrong!.parentNode!.childNodes]) if (sibling !== originalStrong) sibling.remove();
        if (normalize) setTimeout(() => {
          // Captured native-restore-sequence: exact same strong regains its
          // name, while Quill may leave the last task character bold.
          originalStrong!.textContent = '@OneCode';
          const tail = document.createElement('strong'); tail.textContent = 'k';
          originalStrong!.after(document.createTextNode(' Original tas'), tail);
        }, 500);
        return true;
      }
      return edit(command, ui, value);
    };
    const why: string[] = [];
    const pending = api.selectConnector('OneCode', () => lease.current(), (reason: string) => why.push(reason));
    await vi.advanceTimersByTimeAsync(100);
    expect(api.confirmedMention('OneCode')).toBe(false);
    expect(lease.current()).toBe(true); // Only the exact owned transition is provisional.
    await vi.advanceTimersByTimeAsync(normalize ? 1000 : 9000);
    expect(await pending).toBe(normalize);
    expect(why).toEqual(normalize ? [] : ['connector-task-restore-unconfirmed']);
    expect(api.composerAuthoredText()).toBe('Original task'); expect(lease.current()).toBe(true);
    if (normalize) { expect(api.confirmedMention('OneCode')).toBe(true); expect(box.querySelector('strong')).toBe(originalStrong); }
  });
  it.each([true, false])('uses the observed false-execCommand fallback but still requires a real native menu/token: menu=%s', async menu => {
    api.insertPrompt('Original task', true);
    const lease = api.captureComposerDraft('Original task'), edit = document.execCommand;
    document.execCommand = (command, ui, value) => value === '@' ? false : edit(command, ui, value);
    const input = vi.fn((event: Event) => {
      const native = event as InputEvent;
      if (native.inputType === 'insertText' && native.data === '@' && menu) {
        expect(box.textContent).toBe('@'); renderStrongMenu();
      }
    });
    box.addEventListener('input', input);
    const why: string[] = [];
    const pending = api.selectConnector('OneCode', () => lease.current(), (reason: string) => why.push(reason));
    await vi.advanceTimersByTimeAsync(menu ? 1000 : 9000);
    expect(await pending).toBe(menu);
    expect(api.confirmedMention('OneCode')).toBe(menu);
    expect(api.composerAuthoredText()).toBe('Original task'); expect(lease.current()).toBe(true);
    expect(input).toHaveBeenCalled();
    expect(why).toEqual(menu ? [] : ['connector-menu-unavailable']);
  });
  it('preserves the real native popup when execCommand mutates Quill but returns false', async () => {
    api.insertPrompt('Original task', true);
    const lease = api.captureComposerDraft('Original task'), edit = document.execCommand;
    const nativeInput = vi.fn((event: Event) => {
      if ((event as InputEvent).data === '@') {
        // The real native insertion has already opened its popup. A second
        // fallback InputEvent would make Quill close that same popup.
        document.querySelector('.at-mentions-v2-item')?.remove();
      }
    });
    box.addEventListener('input', nativeInput);
    document.execCommand = (command, ui, value) => {
      const done = edit(command, ui, value);
      if (value === '@') { renderStrongMenu(); return false; }
      return done;
    };
    expect(await api.selectConnector('OneCode', () => lease.current())).toBe(true);
    expect(nativeInput.mock.calls.filter(([event]) => (event as InputEvent).data === '@')).toHaveLength(1);
    expect(api.composerAuthoredText()).toBe('Original task'); expect(lease.current()).toBe(true);
    expect(api.confirmedMention('OneCode')).toBe(true);
  });
  it('does not duplicate a session frame when its native edit applies but reports false', async () => {
    api.insertPrompt('Exact task', true); nativeStrongMenu();
    expect(await api.selectConnector('OneCode', () => true)).toBe(true);
    const edit = document.execCommand;
    document.execCommand = (command, ui, value) => { edit(command, ui, value); return false; };
    api.setBindingResolver(async () => binding());
    const clicked = vi.spyOn(document.querySelector('button')!, 'click');
    const pending = api.send({ receiptTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(200);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(box.textContent!.split('[[GEMINI_LOCAL_SESSION]]')).toHaveLength(2);
    expect(box.textContent!.split(key)).toHaveLength(2);
    turn('user', box.textContent || '', 'false-result-frame');
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toBe(true);
  });
  it('accepts observed asynchronous Quill <p>@</p> normalization before native menu and token mount', async () => {
    api.insertPrompt('Original task', true);
    const lease = api.captureComposerDraft('Original task'), edit = document.execCommand;
    document.execCommand = (command, ui, value) => value === '@' ? false : edit(command, ui, value);
    box.addEventListener('input', event => {
      if ((event as InputEvent).data !== '@') return;
      setTimeout(() => {
        box.innerHTML = '<p>@</p>'; // Captured native-editor-after-revoked.json shape.
        expect(lease.current()).toBe(true);
        setTimeout(() => {
          const option = document.createElement('button'); option.className = 'at-mentions-v2-item';
          option.setAttribute('role', 'menuitem'); option.setAttribute('aria-label', 'OneCode'); option.textContent = 'OneCode';
          option.addEventListener('click', () => {
            option.remove();
            setTimeout(() => { box.innerHTML = '<p><strong>@OneCode</strong> </p>'; }, 50);
          }); document.body.append(option);
        }, 50);
      }, 50);
    });
    const why: string[] = [];
    const pending = api.selectConnector('OneCode', () => lease.current(), (reason: string) => why.push(reason));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBe(true); expect(why).toEqual([]);
    expect(api.confirmedMention('OneCode')).toBe(true);
    expect(api.composerAuthoredText()).toBe('Original task'); expect(lease.current()).toBe(true);
  });
  it('revokes the temporary edit for a trusted human edit even if it leaves the same selector text', async () => {
    api.insertPrompt('Original task', true);
    const listen = vi.spyOn(box, 'addEventListener');
    const why: string[] = [];
    const pending = api.selectConnector('OneCode', () => true, (reason: string) => why.push(reason));
    await vi.advanceTimersByTimeAsync(1); // Let native empty normalization and the owned @ edit complete.
    const listener = listen.mock.calls.find(call => call[0] === 'beforeinput')?.[1] as EventListener;
    // jsdom cannot manufacture isTrusted events. Invoke the production listener
    // with the browser's trusted-input evidence, leaving the observed '@' intact.
    listener({ isTrusted: true } as Event);
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toBe(false); expect(why).toEqual(['connector-user-edit']); expect(box.textContent).toBe('@');
    expect(api.confirmedMention('OneCode')).toBe(false);
  });
  it.each([true, false])('never inserts @ until native empty paragraph/caret settle and diagnoses clear reported=%s', async reported => {
    api.insertPrompt('Original task', true);
    const lease = api.captureComposerDraft('Original task'), edit = document.execCommand;
    const diagnostic = vi.spyOn(dom.window.console, 'info').mockImplementation(() => {});
    const attemptedAt = vi.fn();
    document.execCommand = (command, ui, value) => {
      if (!value) { if (reported) box.innerHTML = '<p></p>'; return reported; } // Native empty transaction never settles.
      if (value === '@') attemptedAt();
      return edit(command, ui, value);
    };
    const why: string[] = [];
    const pending = api.selectConnector('OneCode', () => lease.current(), (reason: string) => why.push(reason));
    await vi.advanceTimersByTimeAsync(9000);
    expect(await pending).toBe(false); expect(why).toEqual(['connector-empty-not-settled']);
    expect(attemptedAt).not.toHaveBeenCalled(); expect(api.confirmedMention('OneCode')).toBe(false);
    expect(api.composerAuthoredText()).toBe('Original task'); expect(lease.current()).toBe(true);
    expect(diagnostic).toHaveBeenCalledTimes(1);
    const line = String(diagnostic.mock.calls[0]?.[0]);
    expect(line.startsWith('[OneCode empty selector] ')).toBe(true);
    const evidence = JSON.parse(line.slice('[OneCode empty selector] '.length));
    expect(evidence).toMatchObject({ clearEdit: { reported, applied: reported }, htmlSkeleton: reported ? '<p></p>' : '',
      textLength: 0, domTextLength: 0, editorSame: true, routeSame: true, snapshotOwned: true, trustedEditRevoked: false });
    expect(line).not.toContain('Original task'); expect(line).not.toContain(key);
  });
  it('does not start the selector while Gemini still exposes an enabled Send for an empty-looking document', async () => {
    api.insertPrompt('Original task', true);
    const diagnostic = vi.spyOn(dom.window.console, 'info').mockImplementation(() => {}), edit = document.execCommand, attemptedAt = vi.fn();
    document.execCommand = (command, ui, value) => {
      if (!value) { box.innerHTML = '<p><br></p>'; return true; }
      if (value === '@') attemptedAt();
      return edit(command, ui, value);
    };
    const pending = api.selectConnector('OneCode', () => true);
    await vi.advanceTimersByTimeAsync(9000);
    expect(await pending).toBe(false); expect(attemptedAt).not.toHaveBeenCalled();
    const evidence = JSON.parse(String(diagnostic.mock.calls[0]?.[0]).slice('[OneCode empty selector] '.length));
    expect(evidence).toMatchObject({ htmlSkeleton: '<p><br></p>', textLength: 0, sendPresent: true, sendEnabled: true });
    expect(api.composerAuthoredText()).toBe('Original task');
  });
  it('restores only its own failed selector edit and preserves a foreign edit while the menu is pending', async () => {
    api.insertPrompt('Original task', true);
    const lease = api.captureComposerDraft('Original task');
    const selection = api.selectConnector('OneCode', () => lease.current());
    await vi.advanceTimersByTimeAsync(9000);
    expect(await selection).toBe(false); expect(box.textContent).toBe('Original task'); expect(lease.current()).toBe(true);
    const next = api.selectConnector('OneCode', () => lease.current());
    box.textContent = 'Human replacement';
    await vi.advanceTimersByTimeAsync(250);
    expect(await next).toBe(false); expect(box.textContent).toBe('Human replacement'); expect(lease.current()).toBe(false);
  });
  it('logs only bounded menu/caret evidence on missing native menu without task or credential text', async () => {
    const diagnostic = vi.spyOn(dom.window.console, 'info').mockImplementation(() => {});
    api.insertPrompt('Private task text ' + key, true);
    const pending = api.selectConnector('OneCode', () => true);
    await vi.advanceTimersByTimeAsync(9000);
    expect(await pending).toBe(false); expect(diagnostic).toHaveBeenCalledTimes(1);
    const line = String(diagnostic.mock.calls[0]?.[0]);
    expect(line.startsWith('[OneCode selector] ')).toBe(true);
    const evidence = JSON.parse(line.slice('[OneCode selector] '.length));
    expect(evidence).toMatchObject({ connector: 'OneCode', items: 0, exact: 0, shown: 0, excluded: [], editorOnlyAt: true,
      edit: { reported: true, applied: true } });
    expect(line).not.toContain(key); expect(line).not.toContain('Private task');
    expect(api.composerAuthoredText()).toBe('Private task text ' + key);
  });
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
  it.each(['OneCode Core', 'OneCode Core (Test PC)'])('refuses legacy Gemini Code Core when %s is required and restores the owned draft without Send', async required => {
    const original = 'Original workspace task';
    api.insertPrompt(original, true);
    const lease = api.captureComposerDraft(original), edit = document.execCommand;
    const legacyClick = vi.fn(), skillClick = vi.fn();
    const send = vi.spyOn(document.querySelector('button')!, 'click');
    document.execCommand = (command, ui, value) => {
      const applied = edit(command, ui, value);
      document.querySelectorAll('.at-mentions-v2-item').forEach(node => node.remove());
      if (value === '@') {
        renderStrongMenu('gemini-code').addEventListener('click', skillClick);
        renderStrongMenu('Gemini Code Core').addEventListener('click', legacyClick);
      }
      return applied;
    };
    const why: string[] = [];
    const selection = api.selectConnector(required, () => lease.current(), (reason: string) => why.push(reason));
    await vi.advanceTimersByTimeAsync(9000);
    expect(await selection).toBe(false);
    expect(why).toEqual(['connector-menu-unavailable']);
    expect(api.composerAuthoredText()).toBe(original); expect(lease.current()).toBe(true);
    expect(api.confirmedMention(required)).toBe(false);
    expect(legacyClick).not.toHaveBeenCalled(); expect(skillClick).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(box.textContent).not.toContain('[[GEMINI_LOCAL_SESSION]]');
  });
  it('waits for the exact new user row instead of treating a click as delivery', async () => {
    api.insertPrompt('Exact task', true);
    api.setBindingResolver(async () => binding({ connector_name: 'OneCode' }));
    const chip = document.createElement('span'); chip.className = 'mention-chip'; chip.textContent = 'OneCode'; box.prepend(chip);
    const button = document.querySelector('button')!; const clicked = vi.spyOn(button, 'click');
    const received: string[] = [];
    const pending = api.send({ acceptUserReceipt: (message: any) => { received.push(message.id); return true; }, receiptTimeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(500);
    expect(clicked).toHaveBeenCalledTimes(1); expect(received).toEqual([]);
    expect(box.textContent).toContain('Use only the CURRENT available tool schemas from the app selected in this message.');
    expect(box.textContent).toContain('Never copy or synthesize a full function namespace from older turns.');
    turn('user', 'Exact task' + frame, 'accepted-question');
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toBe(true);
    expect(received).toEqual([`gemini:${id}:user:accepted-question`]);
    expect(clicked).toHaveBeenCalledTimes(1);
  });
  it('accepts the exact visible native user row despite its truncated hidden h5 duplicate', async () => {
    api.insertPrompt('Complete exact native task.', true); nativeStrongMenu(); api.setBindingResolver(async () => binding());
    const received: string[] = [];
    const pending = api.send({ receiptTimeoutMs: 2000, acceptUserReceipt: (message: any) => { received.push(message.id); return true; } });
    await vi.advanceTimersByTimeAsync(500);
    const user = turn('user', '', 'native-accessible-duplicate');
    const content = user.querySelector('.query-text')!;
    const label = document.createElement('h5'); label.className = 'cdk-visually-hidden screen-reader-user-query-label';
    label.innerHTML = '<span>You said</span> @OneCode Complete exact native…';
    const visible = document.createElement('p'); visible.className = 'query-text-line'; visible.textContent = '@OneCode Complete exact native task.';
    const control = document.createElement('p'); control.className = 'query-text-line'; control.textContent = frame;
    content.append(label, visible, control);
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toBe(true);
    expect(received).toEqual([`gemini:${id}:user:native-accessible-duplicate`]);
    expect(api.messages().find((message: any) => message.id.endsWith(':native-accessible-duplicate')).text).toBe('Complete exact native task.');
  });
  it('never resends when native delivery remains ambiguous', async () => {
    api.insertPrompt('Exact task', true); api.setBindingResolver(async () => binding());
    const chip = document.createElement('span'); chip.className = 'mention-chip'; chip.textContent = 'OneCode'; box.prepend(chip);
    const clicked = vi.spyOn(document.querySelector('button')!, 'click'); const why: string[] = [];
    const pending = api.send({ receiptTimeoutMs: 1000, explain: (reason: string) => why.push(reason) });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toBe(false); expect(clicked).toHaveBeenCalledTimes(1);
    expect(why).toContain('send-acceptance-unconfirmed');
  });
  it.each(['before-authorization', 'after-authorization'])('diagnoses draft-changed at %s without exposing task or key', async stage => {
    api.insertPrompt('Private exact task', true); nativeStrongMenu(); api.setBindingResolver(async () => binding());
    const diagnostic = vi.spyOn(dom.window.console, 'info').mockImplementation(() => {});
    const clicked = vi.spyOn(document.querySelector('button')!, 'click'), edit = document.execCommand;
    document.execCommand = (command, ui, value) => {
      const done = edit(command, ui, value);
      if (stage === 'before-authorization' && String(value).includes('[[GEMINI_LOCAL_SESSION]]'))
        (document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).disabled = true;
      return done;
    };
    const why: string[] = [];
    const pending = api.send({ beforeSend: () => {
      (document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).disabled = true; return true;
    }, explain: (reason: string) => why.push(reason) });
    await vi.advanceTimersByTimeAsync(31000);
    expect(await pending).toBe(false); expect(why).toEqual(['draft-changed']); expect(clicked).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledTimes(1);
    const line = String(diagnostic.mock.calls[0]?.[0]);
    const evidence = JSON.parse(line.slice('[OneCode draft] '.length));
    expect(evidence).toMatchObject({ stage, callerCurrent: true, editorSame: true, routeMatches: true, authoredMatches: true,
      sendPresent: true, sendEnabled: false, nativeMentionProof: true, controlFramePresent: true, controlFrameComplete: true, bindingPresent: true });
    expect(line).not.toContain('Private exact task'); expect(line).not.toContain(key);
  });
  it.each(['before-authorization', 'after-authorization'])('waits for a remounted Send while retaining exact draft custody at %s', async stage => {
    api.insertPrompt('Exact task while Core finishes loading', true); nativeStrongMenu(); api.setBindingResolver(async () => binding());
    const button = document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement, parent = button.parentElement!;
    let nativeSends = 0, grants = 0;
    const replaceLater = () => {
      button.remove();
      setTimeout(() => {
        const replacement = button.cloneNode(true) as HTMLButtonElement; replacement.disabled = false;
        replacement.addEventListener('click', () => { nativeSends++; turn('user', box.textContent || '', 'ready-after-remount'); });
        parent.append(replacement);
      }, 1000);
    };
    const edit = document.execCommand;
    document.execCommand = (command, ui, value) => {
      const done = edit(command, ui, value);
      if (stage === 'before-authorization' && String(value).includes('[[GEMINI_LOCAL_SESSION]]')) replaceLater();
      return done;
    };
    const pending = api.send({ beforeSend: () => {
      grants++; expect(api.composerAuthoredText()).toBe('Exact task while Core finishes loading');
      if (stage === 'after-authorization') replaceLater();
      else expect(api.sendButton()).not.toBeNull();
      return true;
    } });
    await vi.advanceTimersByTimeAsync(500);
    expect(nativeSends).toBe(0); expect(grants).toBe(stage === 'after-authorization' ? 1 : 0);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toBe(true); expect(nativeSends).toBe(1); expect(grants).toBe(1);
  });
  it('abandons Send readiness waiting immediately for a foreign draft without authorizing or clicking', async () => {
    api.insertPrompt('Original task', true); nativeStrongMenu(); api.setBindingResolver(async () => binding());
    const edit = document.execCommand, authorize = vi.fn(() => true), clicked = vi.spyOn(document.querySelector('button')!, 'click');
    document.execCommand = (command, ui, value) => {
      const done = edit(command, ui, value);
      if (String(value).includes('[[GEMINI_LOCAL_SESSION]]')) (document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).disabled = true;
      return done;
    };
    const diagnostic = vi.spyOn(dom.window.console, 'info').mockImplementation(() => {});
    const pending = api.send({ beforeSend: authorize });
    await vi.advanceTimersByTimeAsync(500);
    box.textContent = 'Human replacement draft';
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toBe(false); expect(authorize).not.toHaveBeenCalled(); expect(clicked).not.toHaveBeenCalled();
    expect(box.textContent).toBe('Human replacement draft');
    expect(String(diagnostic.mock.calls[0]?.[0])).toContain('"authoredMatches":false');
  });
  it('does not send after binding lookup returns for a navigated chat', async () => {
    api.insertPrompt('Exact task', true);
    let resolve: (value: any) => void = () => {};
    api.setBindingResolver(() => new Promise(done => { resolve = done; }));
    const clicked = vi.spyOn(document.querySelector('button')!, 'click');
    const pending = api.send(); await vi.advanceTimersByTimeAsync(1);
    dom.window.history.replaceState({}, '', '/app/9c16a67b1d474b59'); resolve(binding());
    expect(await pending).toBe(false); expect(clicked).not.toHaveBeenCalled();
  });
  it.each([false, true])('cannot send a stale real-task model when the controlled warm-up never reaches empty UI (foreign edit=%s)', async foreign => {
    dom.window.history.replaceState({}, '', '/app');
    api.insertPrompt('Real task must remain unauthorized', true);
    const edit = document.execCommand;
    document.execCommand = (command, ui, value) => {
      if (!value) { box.innerHTML = '<p><br></p>'; return true; } // Send stays enabled for stale real-task model.
      return edit(command, ui, value);
    };
    const clicked = vi.spyOn(document.querySelector('button')!, 'click'), authorize = vi.fn(() => true), accepted = vi.fn();
    const why: string[] = [];
    const pending = api.send({ beforeSend: authorize, acceptUserReceipt: accepted, explain: (reason: string) => why.push(reason) });
    await vi.advanceTimersByTimeAsync(1);
    if (foreign) box.textContent = 'Human draft';
    await vi.advanceTimersByTimeAsync(9000);
    expect(await pending).toBe(false); expect(why).toContain('warmup-empty-not-settled');
    expect(clicked).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled(); expect(accepted).not.toHaveBeenCalled();
    expect(api.composerAuthoredText()).toBe(foreign ? 'Human draft' : 'Real task must remain unauthorized');
    expect(box.textContent).not.toContain(key);
  });
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
  it('never consumes an already attached native file in the controlled warmup', async () => {
    dom.window.history.replaceState({}, '', '/app'); api.insertPrompt('Preserve this file for my actual task', true);
    const remove = nativeAttachment('scratch.txt', document.querySelector('input-container')!).row;
    const click = vi.spyOn(document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!, 'click'), prepare = vi.fn(), authorize = vi.fn(), why: string[] = [];
    expect(await api.send({ prepareAttachments: prepare, beforeSend: authorize, explain: (reason: string) => why.push(reason) })).toBe(false);
    expect(why).toEqual(['warmup-attachments-present']); expect(click).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled();
    expect(remove.isConnected).toBe(true); expect(box.textContent).toBe('Preserve this file for my actual task');
  });
  it.each([
    { mode: 'ordinary', expectedSkill: false }, { mode: 'owned opening', expectedSkill: true },
    { mode: 'owned command', expectedSkill: true }, { mode: 'unowned frame', expectedSkill: false },
    { mode: 'malformed frame', expectedSkill: false }, { mode: 'authored mention', expectedSkill: false },
    { mode: 'later context mention', expectedSkill: false }
  ])('warms a fresh chat without tools, then binds the original task after Gemini assigns its ID: $mode', async ({ mode, expectedSkill }) => {
    dom.window.history.replaceState({}, '', '/app');
    let submitted = mode === 'ordinary' ? 'Original workspace task' : prependUserPrompt('Original workspace task', '@gemini-code\n\nPlatform: win32.');
    if (mode === 'malformed frame') submitted = submitted.replace(/COS_CONTEXT:\d+/, 'COS_CONTEXT:1');
    if (mode === 'authored mention') submitted = '@gemini-code Original workspace task';
    if (mode === 'later context mention') submitted = prependUserPrompt('Original workspace task', 'Platform: win32.\n@gemini-code');
    if (mode !== 'unowned frame') api.setOpeningClaim({ id: 'scratch-input', owner: 'scratch-owner' });
    if (mode === 'owned command') api.setCommandClaim({ id: 'scratch-command', client: 'scratch-client' });
    api.insertPrompt(submitted, true);
    const resolved = vi.fn(async () => binding()); api.setBindingResolver(resolved);
    const button = document.querySelector('button')!;
    const sent: string[] = [];
    const selections: string[] = [];
    document.addEventListener('click', event => {
      const option = (event.target as Element).closest('.at-mentions-v2-item');
      if (option) selections.push(option.getAttribute('aria-label')!);
    });
    button.addEventListener('click', () => {
      sent.push(box.textContent || '');
      expect(box.querySelector('strong')?.textContent || null).toBe(sent.length === 1 ? (expectedSkill ? '@gemini-code' : null) : '@OneCode');
      const user = document.createElement('user-query'); user.id = sent.length === 1 ? 'warm-up' : 'real-task';
      const content = document.createElement('div'); content.className = 'query-text'; content.textContent = box.textContent;
      // Native token is UI context, not the authored text of the accepted row.
      if (sent.length === 2) content.textContent = content.textContent!.replace(/^OneCode/, '');
      user.append(content); document.querySelector('main')!.append(user); box.textContent = '';
      if (sent.length === 1) {
        expect(resolved).not.toHaveBeenCalled(); expect(sent[0]).not.toContain(key);
        dom.window.history.replaceState({}, '', `/app/${id}`);
        const response = document.createElement('model-response'); response.id = 'ready-answer'; response.textContent = 'READY'; user.after(response);
      }
    });
    nativeStrongMenu(expectedSkill);
    const accepted: any[] = [];
    const pending = api.send({ acceptUserReceipt: (message: any, chat: string) => { accepted.push({ text: message.text, chat }); return true; } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBe(true);
    expect(sent).toHaveLength(2);
    expect(selections).toEqual(expectedSkill ? ['gemini-code', 'OneCode'] : ['OneCode']);
    expect(sent[0]).toBe((expectedSkill ? '@gemini-code ' : '') + warmup);
    expect(api.messages().some((message: any) => message.text.includes('[[GEMINI_LOCAL_WARMUP]]'))).toBe(false);
    expect(sent[1]).toContain('Original workspace task'); expect(sent[1]).toContain(key);
    expect(accepted).toEqual([{ text: submitted, chat: id }]);
    if (mode === 'owned command') expect(resolved).toHaveBeenCalledWith(id, null, { id: 'scratch-command', client: 'scratch-client' });
    else expect(resolved).toHaveBeenCalledWith(id, mode === 'unowned frame' ? null : { id: 'scratch-input', owner: 'scratch-owner' }, null, null);
  });
  it.each(['plain token', 'foreign draft', 'changed route', 'retired claim', 'changed attachments'])(
    'keeps Skill warmup pre-Send until an actual selected token and the original claim/draft are proven: %s', async mode => {
      dom.window.history.replaceState({}, '', '/u/1/app');
      const submitted = prependUserPrompt('Original task must remain unauthorized', '@gemini-code\n\nPlatform: win32.');
      api.setOpeningClaim({ id: 'scratch-input', owner: 'scratch-owner' }); api.insertPrompt(submitted, true);
      const edit = document.execCommand;
      document.execCommand = (command, ui, value) => {
        const result = edit(command, ui, value);
        if (value === '@') {
          renderStrongMenu();
          {
            const skill = renderStrongMenu('gemini-code');
            skill.addEventListener('click', () => {
              if (mode === 'plain token') box.innerHTML = '<p>@gemini-code</p>';
              if (mode === 'foreign draft') box.textContent = 'A human changed this draft';
              if (mode === 'changed route') dom.window.history.replaceState({}, '', '/u/1/app/9c16a67b1d474b59');
              if (mode === 'retired claim') api.setOpeningClaim(null);
              if (mode === 'changed attachments') {
                nativeAttachment('foreign.png', document.querySelector('input-container')!);
              }
            });
          }
        }
        return result;
      };
      const send = vi.spyOn(document.querySelector('button')!, 'click'), authorize = vi.fn(async () => true), resolve = vi.fn(async () => binding());
      api.setBindingResolver(resolve);
      const pending = api.send({ beforeSend: authorize }); await vi.advanceTimersByTimeAsync(12000);
      expect(await pending).toBe(false);
      expect(send).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
      if (mode === 'foreign draft') expect(box.textContent).toBe('A human changed this draft');
      expect(box.textContent).not.toContain(key);
    });
  it.each(['missing option', 'ambiguous option'])('continues with exactly one ordinary warmup if the optional Skill is unavailable: %s', async mode => {
    dom.window.history.replaceState({}, '', '/u/1/app');
    const submitted = prependUserPrompt('Original tool task', '@gemini-code\n\nPlatform: win32.');
    api.setOpeningClaim({ id: 'scratch-input', owner: 'scratch-owner' }); api.insertPrompt(submitted, true);
    nativeStrongMenu();
    const edit = document.execCommand;
    document.execCommand = (command, ui, value) => {
      const result = edit(command, ui, value);
      if (value === '@' && mode === 'ambiguous option') { renderStrongMenu('gemini-code'); renderStrongMenu('gemini-code'); }
      return result;
    };
    const sent: string[] = [], resolver = vi.fn(async () => binding()), authorized = vi.fn(async () => true);
    api.setBindingResolver(resolver);
    document.querySelector('button')!.addEventListener('click', () => {
      sent.push(box.textContent || '');
      const user = document.createElement('user-query'); user.id = sent.length === 1 ? 'ordinary-warmup' : 'real-task';
      const content = document.createElement('div'); content.className = 'query-text'; content.append(...[...box.cloneNode(true).childNodes]);
      user.append(content); document.querySelector('main')!.append(user); box.replaceChildren();
      if (sent.length === 1) {
        expect(sent[0]).toBe(warmup); expect(resolver).not.toHaveBeenCalled(); expect(authorized).not.toHaveBeenCalled();
        dom.window.history.replaceState({}, '', `/u/1/app/${id}`);
        const ready = document.createElement('model-response'); ready.id = 'ready'; ready.textContent = 'READY'; user.after(ready);
      }
    });
    const pending = api.send({ beforeSend: authorized }); await vi.advanceTimersByTimeAsync(16000);
    expect(await pending).toBe(true); expect(sent).toHaveLength(2); expect(authorized).toHaveBeenCalledOnce();
    expect(sent[1]).toContain('@OneCode'); expect(sent[1]).toContain('Original tool task'); expect(sent[0]).not.toContain(key);
    expect(api.messages().filter((message: any) => message.role === 'user').map((message: any) => message.text)).toEqual([submitted]);
  });
});

describe('native model catalog through the shipped recorder', () => {
  it.each(['readable', 'missing', 'draft', 'picker disappeared'] as const)('answers a borrowed chat probe and inspects only its real readable picker: %s', async state => {
    const sent: any[] = []; let listener: any = null;
    const win: any = dom.window; win.CLF_TEST_HOOK = () => {};
    win.chrome = {
      runtime: { id: 'gemini-extension-test', sendMessage: async (message: any) => {
        if (message.type === 'gemini_approval_receipts') return { ok: true, receipts: [] };
        sent.push(message);
        if (message.type === 'status') return { connected: true, paired: true };
        if (message.type === 'activity') return { ok: true, data: { entries: [], nextSince: 0, pendingTools: 0 } };
        if (message.type === 'settings_get') return { ok: true, data: {} };
        return { ok: true, pending: 0, durable: true };
      }, onMessage: { addListener(value: any) { listener = value; }, removeListener() {} } },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } }
    };
    let pickerClicks = 0;
    if (state !== 'missing') {
      const { picker } = nativeModePicker(); picker.addEventListener('click', () => { pickerClicks++; });
    }
    if (state === 'draft') box.textContent = 'Preserve this unsent user draft';
    win.eval(recorderSource); await vi.advanceTimersByTimeAsync(1000);
    let probe: any = null;
    expect(() => listener({ type: 'clf-model-catalog-state' }, {}, (value: any) => { probe = value; })).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toEqual(state === 'readable' || state === 'picker disappeared' ? { ready: true, reason: null } :
      { ready: false, reason: state === 'draft' ? 'draft' : 'picker_unreadable' });
    if (probe.ready) {
      if (state === 'picker disappeared') document.querySelector('button[aria-label^="Open mode picker"]')!.remove();
      const pending = new Promise(resolve => listener({ type: 'clf-model-catalog', nonce: '384c612a-cfd5-4a36-8e48-49b29fd9c2bd', expiresAt: Date.now() + 10000 }, {}, resolve));
      await vi.advanceTimersByTimeAsync(1000); expect(await pending).toEqual({ ok: true });
      expect(sent.filter(message => message.type === 'model_catalog')).toEqual(state === 'picker disappeared' ? [
        expect.objectContaining({ models: null, error: 'picker_unavailable' })
      ] : [
        expect.objectContaining({ models: [
          { id: 'gemini-current', label: 'Automatic (current Gemini model)', efforts: [] },
          ...nativeModelChoices.map(choice => ({ ...choice, efforts: [] }))
        ] })
      ]);
      expect(pickerClicks).toBe(state === 'picker disappeared' ? 0 : 2); expect(document.querySelector('[data-native-models]')).toBeNull();
    } else {
      expect(pickerClicks).toBe(0); expect(sent.some(message => message.type === 'model_catalog')).toBe(false);
      if (state === 'draft') expect(box.textContent).toBe('Preserve this unsent user draft');
    }
  });
});

describe('existing durable recorder with the Gemini adapter', () => {
  it('uses Gemini native final evidence for recovery instead of waiting for a ChatGPT Fiber scan', async () => {
    const flow = approvalExchange(); flow.complete();
    const sent: any[] = []; let hook: any;
    const win: any = dom.window; win.CLF_TEST_HOOK = (value: any) => { hook = value; };
    win.chrome = { runtime: { id: 'gemini-extension-test', sendMessage: async (message: any) => {
      sent.push(message);
      if (message.type === 'gemini_approval_receipts') return { ok: true, receipts: [] };
      if (message.type === 'status') return { connected: true, paired: true };
      if (message.type === 'activity') return { ok: true, data: { entries: [], pendingTools: 0, nextSince: 0 } };
      if (message.type === 'settings_get') return { ok: true, data: {} };
      return { ok: true, pending: 0, durable: true };
    }, onMessage: { addListener() {}, removeListener() {} } }, storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } } };
    win.eval(recorderSource); await vi.advanceTimersByTimeAsync(1000);
    const note = vi.fn();
    expect(await hook.recoveryPageUnfinished(() => true, note)).toBe(true);
    flow.response.innerHTML = '<message-content>Actual native final</message-content><div class="response-footer complete"></div>';
    expect(await hook.recoveryPageUnfinished(() => true, note)).toBe(false);
    expect(note).toHaveBeenLastCalledWith('page-final');
    expect(sent.some(row => row.type === 'repair_fiber')).toBe(false);
    expect(await hook.recoveryPageUnfinished(() => false, note)).toBe(false);
    expect(note).toHaveBeenLastCalledWith('lease-lost');
  });
  it.each(['final after ACK', 'delayed final', 'no footer', 'busy', 'blocking error', 'human Stop', 'foreign question', 'route changed',
    'claim cancelled', 'ACK refused', 'ACK delayed', 'question ID changed', 'empty final'] as const)(
    'publishes only the exact acknowledged native Gemini helper final through its existing decision owner: %s', async mode => {
    const inputId = 'f79f753b-c445-4eba-9ede-c0eba99e9a1b', owner = '10:document-test:0';
    const task = 'Create a two-stage scratch-file verification plan.', sent: any[] = [];
    let listener: any, hook: any, nativeSends = 0, releaseACK: (value: any) => void = () => {};
    dom.window.history.replaceState({}, '', `/u/1/app?cos-helper=planner&cos-input=${inputId}`);
    dom.window.eval(source); api = (dom.window as any).CLF_DOM;
    dom.window.eval(markdownSource);
    const listeners = vi.spyOn(document, 'addEventListener');
    const win: any = dom.window; win.CLF_TEST_HOOK = (value: any) => { hook = value; };
    win.chrome = {
      runtime: { id: 'gemini-extension-test', sendMessage: async (message: any) => {
        if (message.type === 'gemini_approval_receipts') return { ok: true, receipts: [] };
        sent.push(message);
        if (message.type === 'status') return { connected: true, paired: true };
        if (message.type === 'activity') return { ok: true, data: { entries: [], pendingTools: 0, nextSince: 0 } };
        if (message.type === 'settings_get') return { ok: true, data: {} };
        if (message.type === 'desktop_input') {
          if (message.ack) return mode === 'ACK delayed' ? new Promise(resolve => { releaseACK = resolve; }) : { ok: true, data: { ok: mode !== 'ACK refused' } };
          if (message.authorize || message.response || message.partial || message.fail) return { ok: true, data: { ok: true } };
          return { ok: true, data: { input: { id: inputId, owner, text: task, purpose: 'decision',
            lifetime: 'temporary-planner', opening: true, images: [], attachments: [] } } };
        }
        return { ok: true, durable: true, pending: 0 };
      }, onMessage: { addListener(value: any) { listener = value; }, removeListener() {} } },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } }
    };
    const exchange = document.createElement('div'); exchange.className = 'conversation-container'; exchange.id = '1389343ff5b60584';
    const user = document.createElement('user-query'); user.innerHTML = '<div class="query-text"></div>';
    document.querySelector('button[aria-label="Send message"]')!.addEventListener('click', () => {
      nativeSends++; user.querySelector('.query-text')!.textContent = api.composerAuthoredText();
      exchange.append(user); document.querySelector('main')!.append(exchange); box.replaceChildren();
      dom.window.history.replaceState({}, '', `/u/1/app/${id}?cos-helper=planner&cos-input=${inputId}`);
    });
    win.eval(recorderSource); await vi.advanceTimersByTimeAsync(1000);
    const result = new Promise(resolve => listener({ type: 'clf-desktop-input', id: inputId, conversationId: null }, {}, resolve));
    await vi.advanceTimersByTimeAsync(3000);
    expect(nativeSends).toBe(1); expect(sent.filter(message => message.type === 'desktop_input' && message.ack)).toHaveLength(1);
    if (mode !== 'ACK delayed') expect(await result).toEqual({ ok: mode !== 'ACK refused' });
    expect(sent.some(message => message.type === 'gemini_binding')).toBe(false); // Tool-free native helper.
    const template = document.createElement('template'); template.innerHTML = nativePlanFinal;
    const final = template.content.querySelector('model-response')!;
    const footer = final.querySelector('.response-footer.complete')!;
    if (mode === 'claim cancelled') listener({ type: 'clf-tab-close-check', conversationId: id,
      cancelledDecisions: [{ id: inputId, owner }] }, {}, () => {});
    if (mode === 'delayed final' || mode === 'no footer') footer.classList.remove('complete');
    if (mode === 'busy') final.querySelector('message-content')!.setAttribute('aria-busy', 'true');
    if (mode === 'blocking error') { const alert = document.createElement('div'); alert.role = 'alert'; alert.textContent = 'Synthetic native failure'; document.body.append(alert); }
    if (mode === 'human Stop') {
      const stop = document.createElement('button'); stop.ariaLabel = 'Stop response'; document.body.append(stop);
      const note = listeners.mock.calls.find(call => call[0] === 'click' && (call[1] as Function)?.name === 'noteStopClick')![1] as EventListener;
      note({ isTrusted: true, target: stop } as unknown as Event); stop.remove();
    }
    if (mode === 'empty final') final.querySelector('message-content')!.replaceChildren();
    exchange.append(final);
    if (mode === 'foreign question') { const next = document.createElement('user-query'); next.id = 'new-human-question'; next.innerHTML = '<div class="query-text">Different real question</div>'; exchange.append(next); }
    if (mode === 'question ID changed') exchange.id = 'ffffffffffffffff';
    if (mode === 'route changed') dom.window.history.replaceState({}, '', `/u/1/app/9c16a67b1d474b59?cos-helper=planner&cos-input=${inputId}`);
    hook.observe(); await vi.advanceTimersByTimeAsync(1000);
    expect(sent.filter(message => message.type === 'desktop_input' && message.response)).toHaveLength(mode === 'final after ACK' ? 1 : 0);
    if (mode === 'delayed final') { footer.classList.add('complete'); hook.observe(); }
    if (mode === 'ACK delayed') {
      releaseACK({ ok: true, data: { ok: true } }); await vi.advanceTimersByTimeAsync(100);
      expect(await result).toEqual({ ok: true }); hook.observe();
    }
    await vi.advanceTimersByTimeAsync(1000);
    const responses = sent.filter(message => message.type === 'desktop_input' && message.response);
    expect(responses).toHaveLength(mode === 'final after ACK' || mode === 'delayed final' || mode === 'ACK delayed' ? 1 : 0);
    if (responses.length) {
      expect(responses[0]).toMatchObject({ id: inputId, owner, lifetime: 'temporary-planner' });
      const parsed = JSON.parse(responses[0].response.replace(/^\s*```json\s*|\s*```\s*$/g, ''));
      expect(parsed.action).toBe('continue'); expect(typeof parsed.reply).toBe('string');
      hook.observe(); await vi.advanceTimersByTimeAsync(1000);
      expect(sent.filter(message => message.type === 'desktop_input' && message.response)).toHaveLength(1);
    }
    expect(sent.filter(message => message.type === 'events')).toEqual([]);
  });
  it.each(['existing', 'fresh', 'foreign attachment after upload'] as const)(
    'selects native Core before seven files enable Send, then authorizes only the unchanged real upload lease: %s', async mode => {
    const fresh = mode === 'fresh', inputId = '878ec7a1-9be1-477e-a073-3db6b8d56b92', owner = '10:document-test:0';
    const task = 'Inspect my seven attached scratch files', sent: any[] = [], nativeSends: string[] = []; let listener: any = null;
    const names = ['probe-shapes.png', 'probe-shapes.jpg', 'probe-note.txt', 'probe-document.pdf', 'probe-table.csv', 'probe-code.py', 'probe-archive.zip'];
    const transportedNames = names.map(name => /\.csv$/i.test(name) ? name + '.txt' : name);
    const attachments = names.map((name, index) => ({ id: `staged-file-${index}`, name, size: 4, mimeType: name.endsWith('.png') ? 'image/png' : 'application/octet-stream' }));
    dom.window.history.replaceState({}, '', fresh ? `/u/1/app?cos-input=${inputId}` : `/u/1/app/${id}`);
    const uploaded = vi.fn((files: File[], host: HTMLElement) => {
      expect(nativeSends).toEqual(fresh ? [warmup] : []);
      expect(api.confirmedMention('OneCode')).toBe(true); expect(api.composerAuthoredText()).toBe(task);
      expect(files.map(file => file.name)).toEqual(transportedNames); expect(files.every(file => file.size === 4)).toBe(true);
      for (const file of files) nativeAttachment(file.name, host);
      document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.disabled = false;
      if (mode === 'foreign attachment after upload') nativeAttachment('human.txt', host);
    });
    const surface = nativeUploadSurface(uploaded);
    const win: any = dom.window; win.CLF_TEST_HOOK = () => {};
    win.chrome = {
      runtime: { id: 'gemini-extension-test', sendMessage: async (message: any) => {
        if (message.type === 'gemini_approval_receipts') return { ok: true, receipts: [] };
        sent.push(message);
        if (message.type === 'status') return { connected: true, paired: true, connectorNames: { core: 'OneCode' } };
        if (message.type === 'activity') return { ok: true, data: { entries: [], nextSince: 0, pendingTools: 0 } };
        if (message.type === 'settings_get') return { ok: true, data: {} };
        if (message.type === 'gemini_binding') {
          expect(api.composerAttachmentNames()).toEqual([]); expect(uploaded).not.toHaveBeenCalled();
          expect(message.input).toEqual({ id: inputId, owner });
          expect(message.opening).toEqual(fresh ? { id: inputId, owner } : undefined);
          return { ok: true, data: binding() };
        }
        if (message.type === 'desktop_input') {
          if (message.attachmentId) return { ok: true, data: { chunk: win.btoa('TEST') } };
          if (message.authorize) {
            expect(api.composerAttachmentNames()).toEqual([...transportedNames].sort()); expect(api.confirmedMention('OneCode')).toBe(true);
            expect(box.textContent).toContain('[[GEMINI_LOCAL_SESSION]]'); expect(box.textContent).toContain(key);
            return { ok: true, data: { ok: true } };
          }
          if (message.ack || message.fail) return { ok: true, data: { ok: true } };
          return { ok: true, data: { input: { id: inputId, owner, text: task, images: [], opening: fresh, attachments } } };
        }
        return { ok: true, pending: 0, durable: true };
      }, onMessage: { addListener(value: any) { listener = value; }, removeListener() {} } },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } }
    };
    nativeStrongMenu();
    const nativeEdit = document.execCommand;
    document.execCommand = (command, ui, value) => {
      const changed = nativeEdit(command, ui, value);
      // Actual Gemini permits a file-only Send. Clearing text cannot create the
      // empty selector boundary after a file is staged, even when the task clears.
      if (api.hasComposerAttachments()) document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.disabled = false;
      return changed;
    };
    document.querySelector('button[aria-label="Send message"]')!.addEventListener('click', () => {
      const first = fresh && !nativeSends.length;
      expect(api.composerAttachmentNames()).toEqual(first ? [] : [...transportedNames].sort());
      nativeSends.push(api.composerAuthoredText());
      const user = turn('user', box.textContent || '', first ? 'warmup' : 'native-file-task'); box.replaceChildren();
      surface.host.querySelectorAll('uploader-file-preview').forEach(row => row.remove());
      if (first) {
        dom.window.history.replaceState({}, '', `/u/1/app/${id}`);
        const response = document.createElement('model-response'); response.textContent = 'READY'; user.after(response);
      }
    });
    win.eval(recorderSource); await vi.advanceTimersByTimeAsync(1000);
    const result = new Promise(resolve => listener({ type: 'clf-desktop-input', id: inputId, conversationId: fresh ? null : id }, {}, resolve));
    await vi.advanceTimersByTimeAsync(12000); expect(await result).toEqual({ ok: mode !== 'foreign attachment after upload' });
    expect(uploaded).toHaveBeenCalledOnce();
    expect(sent.filter(message => message.type === 'desktop_input' && message.authorize)).toHaveLength(mode === 'foreign attachment after upload' ? 0 : 1);
    expect(sent.filter(message => message.type === 'desktop_input' && message.ack)).toHaveLength(mode === 'foreign attachment after upload' ? 0 : 1);
    expect(nativeSends).toEqual(mode === 'foreign attachment after upload' ? [] : fresh ? [warmup, task] : [task]);
    if (mode === 'foreign attachment after upload') expect(api.composerAttachmentNames()).toEqual([...transportedNames, 'human.txt'].sort());
  });
  it.each(['existing', 'fresh delayed identity', 'fresh identity unavailable', 'fresh route changed'] as const)(
    'publishes an accepted Desktop question through the normal recorder before ACK without bypassing identity: %s', async mode => {
    const fresh = mode !== 'existing', inputId = '878ec7a1-9be1-477e-a073-3db6b8d56b92', owner = '10:document-test:0';
    const task = 'Actual accepted scratch question', sent: any[] = [], nativeSends: string[] = []; let listener: any = null, hook: any = null;
    const win: any = dom.window; win.Date.now = () => Date.now(); win.CLF_TEST_HOOK = (value: any) => { hook = value; };
    dom.window.history.replaceState({}, '', fresh ? `/u/1/app?cos-input=${inputId}` : `/u/1/app/${id}`);
    // Reproduce hidden-page scheduling: the native adapter still observes its
    // own receipts, but transcript debounce/ordinary ticks have not run yet.
    const RealObserver = win.MutationObserver, nativeTimeout = win.setTimeout.bind(win);
    win.MutationObserver = class {
      inner: MutationObserver;
      constructor(callback: MutationCallback) { this.inner = new RealObserver(callback); }
      observe(target: Node, options: MutationObserverInit) {
        if (target === document.body && options.attributeFilter?.includes('data-testid')) return;
        this.inner.observe(target, options);
      }
      disconnect() { this.inner.disconnect(); }
      takeRecords() { return this.inner.takeRecords(); }
    };
    win.setTimeout = (callback: any, ms: number, ...args: any[]) => nativeTimeout(callback, ms === 1000 ? 50000 : ms, ...args);
    const observations = () => sent.filter(message => message.type === 'events').flatMap(message => message.entries.map((entry: any) => entry.event));
    let gated = false;
    win.chrome = {
      runtime: { id: 'gemini-extension-test', sendMessage: async (message: any) => {
        if (message.type === 'gemini_approval_receipts') return { ok: true, receipts: [] };
        sent.push(message);
        if (message.type === 'status') return { connected: true, paired: true, connectorNames: { core: 'OneCode' } };
        if (message.type === 'settings_get') return { ok: true, data: {} };
        if (message.type === 'activity') {
          if (gated) {
            if (mode === 'fresh identity unavailable') return new Promise(() => {});
            await new Promise(resolve => nativeTimeout(resolve, 300));
          }
          return { ok: true, data: { entries: [], nextSince: 0, userAnchors: [], pendingTools: 0 } };
        }
        if (message.type === 'gemini_binding') return { ok: true, data: binding() };
        if (message.type === 'desktop_input') {
          if (message.ack) {
            expect(message).toMatchObject({ owner, conversationId: id, messageId: `gemini:${id}:user:actual-task` });
            const starts = observations().filter((event: any) => event.kind === 'turn_start');
            if (mode === 'existing' || mode === 'fresh delayed identity') {
              expect(starts).toHaveLength(1);
              expect(observations().filter((event: any) => event.kind === 'user_message')).toEqual([
                expect.objectContaining({ messageId: `gemini:${id}:user:actual-task`, text: task })
              ]);
            } else expect(starts).toEqual([]);
            return { ok: true, data: { ok: mode !== 'fresh route changed' } };
          }
          if (message.authorize || message.fail) return { ok: true, data: { ok: true } };
          return { ok: true, data: { input: { id: inputId, owner, text: task, images: [], attachments: [], opening: fresh } } };
        }
        return { ok: true, pending: 0, durable: true };
      }, onMessage: { addListener(value: any) { listener = value; }, removeListener() {} } },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } }
    };
    nativeStrongMenu();
    document.querySelector('button[aria-label="Send message"]')!.addEventListener('click', () => {
      nativeSends.push(api.composerAuthoredText());
      const user = turn('user', box.textContent || '', fresh && nativeSends.length === 1 ? 'warmup' : 'actual-task'); box.replaceChildren();
      if (fresh && nativeSends.length === 1) {
        dom.window.history.replaceState({}, '', `/u/1/app/${id}`);
        const response = document.createElement('model-response'); response.textContent = 'READY'; user.after(response);
        gated = true; hook.observe(); // Warm-up hydration arms the normal adoption/history gate.
      } else if (mode === 'fresh route changed') {
        nativeTimeout(() => dom.window.history.replaceState({}, '', '/u/1/app/9c16a67b1d474b59'), 100);
      }
    });
    win.eval(recorderSource); await vi.advanceTimersByTimeAsync(20);
    const result = new Promise(resolve => listener({ type: 'clf-desktop-input', id: inputId, conversationId: fresh ? null : id }, {}, resolve));
    await vi.advanceTimersByTimeAsync(mode === 'fresh identity unavailable' ? 6000 : 900);
    expect(await result).toEqual({ ok: mode !== 'fresh route changed' });
    expect(sent.filter(message => message.type === 'desktop_input' && message.ack)).toHaveLength(1);
    expect(nativeSends).toEqual(fresh ? [warmup, task] : [task]);
    if (mode === 'fresh identity unavailable' || mode === 'fresh route changed')
      expect(observations().some((event: any) => event.kind === 'user_message' || event.kind === 'turn_start')).toBe(false);
  });
  it.each(['existing', 'fresh', 'fresh remount', 'fresh foreign edit'] as const)(
    'retains the shipped Desktop claim/draft through deferred file preparation and never authorizes an unconfirmed upload: %s', async mode => {
    const fresh = mode !== 'existing', inputId = '878ec7a1-9be1-477e-a073-3db6b8d56b92', owner = '10:document-test:0';
    const task = 'Inspect my scratch attachment', sent: any[] = [], nativeSends: string[] = []; let listener: any = null;
    dom.window.history.replaceState({}, '', fresh ? `/u/1/app?cos-input=${inputId}` : `/u/1/app/${id}`);
    const win: any = dom.window; win.CLF_TEST_HOOK = () => {};
    win.chrome = {
      runtime: { id: 'gemini-extension-test', sendMessage: async (message: any) => {
        if (message.type === 'gemini_approval_receipts') return { ok: true, receipts: [] };
        sent.push(message);
        if (message.type === 'status') return { connected: true, paired: true, connectorNames: { core: 'OneCode' } };
        if (message.type === 'activity') return { ok: true, data: { entries: [], nextSince: 0, pendingTools: 0 } };
        if (message.type === 'settings_get') return { ok: true, data: {} };
        if (message.type === 'gemini_binding') return { ok: true, data: binding() };
        if (message.type === 'desktop_input') {
          if (message.attachmentId) return { ok: true, data: { chunk: win.btoa('TEST') } };
          if (message.fail) return { ok: true, data: { ok: true } };
          return { ok: true, data: { input: { id: inputId, owner, text: task, images: [], opening: fresh,
            attachments: [{ id: 'staged-file', name: 'scratch.txt', size: 4, mimeType: 'text/plain' }] } } };
        }
        return { ok: true, pending: 0, durable: true };
      }, onMessage: { addListener(value: any) { listener = value; }, removeListener() {} } },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } }
    };
    nativeStrongMenu();
    // Deliberately reject at the upload boundary: this test proves the real
    // content lease/order without manufacturing native file acceptance.
    const upload = vi.spyOn(api, 'uploadImages').mockImplementation(async (_images: any, current: any, draft: any, files: any) => {
      expect(current()).toBe(true); expect(draft.current()).toBe(true); expect(api.conversationId()).toBe(id);
      expect(api.composerAuthoredText()).toBe(task); expect(nativeSends).toEqual(fresh ? [warmup] : []);
      expect(files).toHaveLength(1); expect(files[0]).toBeInstanceOf(win.File);
      expect(files[0]).toMatchObject({ name: 'scratch.txt', size: 4, type: 'text/plain' }); return false;
    });
    document.querySelector('button[aria-label="Send message"]')!.addEventListener('click', () => {
      nativeSends.push(api.composerAuthoredText()); expect(upload).not.toHaveBeenCalled();
      const user = turn('user', box.textContent || '', 'warmup-user'); box.replaceChildren();
      dom.window.history.replaceState({}, '', `/u/1/app/${id}`);
      const response = document.createElement('model-response'); response.textContent = 'READY'; user.after(response);
      if (mode === 'fresh remount') { const replacement = box.cloneNode(true) as HTMLElement; box.replaceWith(replacement); box = replacement; }
      if (mode === 'fresh foreign edit') box.textContent = 'Preserve my new draft';
    });
    win.eval(recorderSource); await vi.advanceTimersByTimeAsync(1000);
    const result = new Promise(resolve => listener({ type: 'clf-desktop-input', id: inputId, conversationId: fresh ? null : id }, {}, resolve));
    await vi.advanceTimersByTimeAsync(3000); expect(await result).toEqual({ ok: false });
    expect(upload).toHaveBeenCalledTimes(mode === 'existing' || mode === 'fresh' ? 1 : 0);
    expect(nativeSends).toEqual(fresh ? [warmup] : []);
    expect(sent.filter(message => message.type === 'desktop_input' && (message.authorize || message.ack))).toEqual([]);
    const failure = sent.find(message => message.type === 'desktop_input' && message.fail);
    expect(failure?.error).toContain(mode === 'fresh foreign edit' ? 'warmup-not-settled' : 'Attachment upload was not confirmed');
    if (mode === 'fresh foreign edit') expect(box.textContent).toBe('Preserve my new draft');
  });
  it.each([false, true])('keeps a hydrating Desktop Send one question through a delayed ACK and real native generation=%s', async busyNative => {
    const inputId = '878ec7a1-9be1-477e-a073-3db6b8d56b92', owner = '10:document-test:0', exchangeId = '4c9572492c5bc90b';
    const sent: any[] = []; let listener: any = null, hook: any = null, nativeSends = 0;
    const win: any = dom.window; win.Date.now = () => Date.now();
    dom.window.history.replaceState({}, '', `/u/1/app/${id}`);
    win.CLF_TEST_HOOK = (value: any) => { hook = value; };
    const observations = () => sent.filter(message => message.type === 'events').flatMap(message => (message.entries || []).map((entry: any) => entry.event));
    win.chrome = {
      runtime: { id: 'gemini-extension-test', sendMessage: async (message: any) => {
        if (message.type === 'gemini_approval_receipts') return { ok: true, receipts: [] };
        sent.push(message);
        if (message.type === 'status') return { connected: true, paired: true, connectorNames: { core: 'OneCode' } };
        if (message.type === 'activity') {
          const events = observations(), starts = events.filter((event: any) => event.kind === 'turn_start'), latest = starts.at(-1);
          const ended = latest && events.some((event: any) => event.kind === 'turn_end' && event.turnId === latest.turnId);
          return { ok: true, data: { entries: [], nextSince: 0, userAnchors: events.filter((event: any) => event.kind === 'user_message')
            .map((event: any, seq: number) => ({ messageId: event.messageId, seq: seq + 1, time: Date.now() })),
            activeTurnId: ended ? null : latest?.turnId || null, recordedTurnId: ended ? null : latest?.turnId || null,
            recordedQuestionId: latest ? `gemini:${id}:user:${exchangeId}` : null, pendingTools: 0 } };
        }
        if (message.type === 'settings_get') return { ok: true, data: {} };
        if (message.type === 'gemini_binding') return { ok: true, data: binding() };
        if (message.type === 'desktop_input') {
          if (message.authorize || message.fail) return { ok: true, data: { ok: true } };
          if (message.ack) { await new Promise(resolve => setTimeout(resolve, 8000)); return { ok: true, data: { ok: true } }; }
          return { ok: true, data: { input: { id: inputId, owner, text: 'What skills do you have?', images: [], attachments: [], opening: false } } };
        }
        return { ok: true, pending: 0, durable: true };
      }, onMessage: { addListener(value: any) { listener = value; }, removeListener() {} } },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } }
    };
    nativeStrongMenu();
    document.querySelector('button[aria-label="Send message"]')!.addEventListener('click', () => {
      nativeSends++;
      const container = document.createElement('div'); container.className = 'conversation-container'; container.id = 'undefined';
      const user = document.createElement('user-query'), content = document.createElement('div'); content.className = 'query-text'; content.id = 'user-query-content-undefined';
      content.append(...[...box.cloneNode(true).childNodes]); user.append(content);
      const response = document.createElement('model-response'); response.innerHTML = '<message-content id="message-content-id-undefined">Here are the available skills.</message-content><div class="response-footer complete"></div>';
      container.append(user, response); document.querySelector('main')!.append(container); box.replaceChildren();
      let stop: HTMLButtonElement | null = null;
      if (busyNative) { stop = document.createElement('button'); stop.ariaLabel = 'Stop response'; document.body.append(stop); setTimeout(() => stop!.remove(), 6000); }
      setTimeout(() => { container.id = exchangeId; content.id = 'user-query-content-0'; }, 250);
    });
    win.eval(recorderSource); await vi.advanceTimersByTimeAsync(1000);
    const delivered = new Promise(resolve => listener({ type: 'clf-desktop-input', id: inputId, conversationId: id }, {}, resolve));
    await vi.advanceTimersByTimeAsync(3000);
    if (busyNative) expect(observations().filter((event: any) => event.kind === 'turn_end')).toEqual([]);
    await vi.advanceTimersByTimeAsync(13000); expect(await delivered).toEqual({ ok: true });
    hook.observe(); await hook.flush(); await hook.pullActivity(); hook.observe(); await hook.flush();
    expect(nativeSends).toBe(1);
    const starts = observations().filter((event: any) => event.kind === 'turn_start'), ends = observations().filter((event: any) => event.kind === 'turn_end');
    expect(starts).toHaveLength(1); expect(ends).toEqual([expect.objectContaining({ turnId: starts[0].turnId, outcome: 'completed' })]);
    const users = observations().filter((event: any) => event.kind === 'user_message');
    expect(users).toHaveLength(1); expect(users[0].messageId).toBe(`gemini:${id}:user:${exchangeId}`);
    const acks = sent.filter(message => message.type === 'desktop_input' && message.ack);
    expect(acks).toHaveLength(1); expect(acks[0].messageId).toBe(`gemini:${id}:user:${exchangeId}`);
    expect(JSON.stringify(observations())).not.toContain('user-query-content-undefined');
  });
  it.each([false, true])('settles the original canonical turn after native autoapproval and records its code fence without an Allow subturn (completed card removed=%s)', async removed => {
    const flow = approvalExchange(), sent: any[] = []; let hook: any = null, enabledPolicy = false, pageListener: any = null;
    const win: any = dom.window, nativeTurnId = 'g-original-approval-task';
    win.eval(markdownSource); win.Date.now = () => Date.now();
    flow.permission.allow.addEventListener('click', () => {
      flow.complete();
      const respond = () => {
        const row = flow.reply();
        row.querySelector('message-content')!.innerHTML = '<p>Exact graph:</p><code-block><div class="formatted-code-block-internal-container"><div class="code-block-decoration"><span>JSON</span><button>Copy code</button></div><pre><code data-test-id="code-content">{"entities":[],"relations":[]}</code></pre></div></code-block>';
      };
      if (removed) { setTimeout(() => flow.permission.element.remove(), 400); setTimeout(respond, 700); }
      else respond();
    });
    win.CLF_TEST_HOOK = (value: any) => { hook = value; };
    win.chrome = {
      runtime: { id: 'gemini-extension-test', sendMessage: async (message: any) => {
        if (message.type === 'gemini_approval_receipts') return { ok: true, receipts: [] };
        sent.push(message);
        if (message.type === 'status') return { connected: true, paired: true };
        if (message.type === 'gemini_binding') return enabledPolicy ? { ok: true, data: binding() } : { ok: false };
        if (message.type === 'activity') return { ok: true, data: { entries: [], stream: [], nextSince: 0,
          activeTurnId: nativeTurnId, recordedTurnId: nativeTurnId,
          recordedQuestionId: `gemini:${id}:user:91b9af7227ff18ee`, pendingTools: 0 } };
        if (message.type === 'settings_get') return { ok: true, data: {} };
        return { ok: true, pending: 0, durable: true };
      }, onMessage: { addListener(listener: any) { pageListener = listener; }, removeListener() {} } },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } }
    };
    win.eval(recorderSource); await vi.advanceTimersByTimeAsync(1000);
    enabledPolicy = true; await api.maybeAutoApprove();
    hook.observe(); await vi.advanceTimersByTimeAsync(1000); hook.observe();
    await vi.advanceTimersByTimeAsync(hook.TURN_SETTLE_MS + 100); hook.observe(); await hook.flush();
    const observations = sent.filter(message => message.type === 'events').flatMap(message => (message.entries || []).map((entry: any) => entry.event));
    expect(observations.filter((event: any) => event.kind === 'turn_start')).toEqual([]);
    expect(observations.filter((event: any) => event.kind === 'turn_end'), JSON.stringify({ audit: api.approvalAudit(),
      events: observations.map((event: any) => ({ kind: event.kind, turnId: event.turnId, messageId: event.messageId, state: event.state }))
    })).toEqual([expect.objectContaining({ turnId: nativeTurnId, outcome: 'completed' })]);
    expect(observations.some((event: any) => event.kind === 'user_message' && event.text === 'Allow')).toBe(false);
    expect(observations.some((event: any) => event.kind === 'assistant_message' && event.turnId === nativeTurnId && event.text.includes('```json\n{"entities":[],"relations":[]}\n```'))).toBe(true);
    expect(observations.some((event: any) => event.kind === 'tool_call')).toBe(false);
    let page: any = null;
    pageListener({ type: 'clf-page-status' }, {}, (value: any) => { page = value; });
    expect(page.geminiApprovalAudit.at(-1)).toMatchObject({ stage: 'matched', reason: 'completed-control',
      sourceId: '91b9af7227ff18ee', candidateId: 'ba53d8ce31d0aabb' });
  });
  it.each([
    ['final', 'completed'], ['no-footer', null], ['history-final', null], ['cross-question', 'interrupted'],
    ['error', 'failed'], ['cancel', 'stopped'], ['already-complete', 'completed'], ['busy', null]
  ] as const)('moves an unknown Gemini quiet section only through the same question and actual terminal evidence: %s', async (mode, outcome) => {
    const sent: any[] = []; let hook: any = null;
    const win: any = dom.window, canonical = 'g-original-native-question'; win.Date.now = () => Date.now();
    const question = turn('user', 'Original native question', 'owned-native-question');
    const initial = document.createElement('model-response'); initial.id = 'initial-owned-section';
    initial.innerHTML = '<message-content></message-content>';
    if (mode === 'already-complete') initial.innerHTML = '<message-content>Original completed answer</message-content><div class="response-footer complete"></div>';
    question.after(initial);
    const listeners = vi.spyOn(document, 'addEventListener');
    win.CLF_TEST_HOOK = (value: any) => { hook = value; };
    win.chrome = {
      runtime: { id: 'gemini-extension-test', sendMessage: async (message: any) => {
        if (message.type === 'gemini_approval_receipts') return { ok: true, receipts: [] };
        sent.push(message);
        if (message.type === 'status') return { connected: true, paired: true };
        if (message.type === 'activity') return { ok: true, data: { entries: [], stream: [], nextSince: 0,
          activeTurnId: canonical, recordedTurnId: canonical, recordedQuestionId: `gemini:${id}:user:owned-native-question`, pendingTools: 0 } };
        if (message.type === 'settings_get') return { ok: true, data: {} };
        return { ok: true, pending: 0, durable: true };
      }, onMessage: { addListener() {}, removeListener() {} } },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } }
    };
    win.eval(recorderSource); await vi.advanceTimersByTimeAsync(1000); hook.observe();
    if (mode === 'already-complete') { await vi.advanceTimersByTimeAsync(hook.TURN_SETTLE_MS + 100); hook.observe(); }
    if (mode === 'error') { const error = document.createElement('div'); error.role = 'alert'; error.textContent = 'Native fixture failure'; document.body.append(error); hook.observe(); }
    if (mode === 'cancel' || mode === 'busy') {
      const stop = document.createElement('button'); stop.ariaLabel = 'Stop response'; document.body.append(stop);
      if (mode === 'cancel') {
        const note = listeners.mock.calls.find(call => call[0] === 'click' && (call[1] as Function)?.name === 'noteStopClick')![1] as EventListener;
        note({ isTrusted: true, target: stop } as unknown as Event); stop.remove();
      }
    }
    const final = document.createElement('model-response'); final.id = 'later-native-section';
    final.innerHTML = '<message-content>New actual final answer</message-content>' + (mode === 'no-footer' ? '' : '<div class="response-footer complete"></div>');
    if (mode === 'history-final') question.before(final);
    else {
      if (mode === 'cross-question') { const next = document.createElement('user-query'); next.id = 'foreign-question'; next.innerHTML = '<div class="query-text">A different real question</div>'; initial.after(next); next.after(final); }
      else initial.after(final);
    }
    hook.observe(); await vi.advanceTimersByTimeAsync(hook.TURN_SETTLE_MS + 100); hook.observe(); await hook.flush();
    const observations = sent.filter(message => message.type === 'events').flatMap(message => (message.entries || []).map((entry: any) => entry.event));
    const ends = observations.filter((event: any) => event.kind === 'turn_end' && event.turnId === canonical);
    expect(ends.map((event: any) => event.outcome)).toEqual(outcome ? [outcome] : []);
    if (mode === 'cross-question') expect(observations.some((event: any) => event.kind === 'assistant_message' &&
      event.messageId === `gemini:${id}:assistant:later-native-section` && event.turnId === canonical)).toBe(false);
    if (!['cross-question', 'already-complete'].includes(mode)) expect(observations.filter((event: any) => event.kind === 'turn_start')).toEqual([]);
  });
  it.each(['', '?clf=6d4e359f1cea2103', '#clf=6d4e359f1cea2103', '?cos-input=7bd480b6-1234-4567-89ab-123456789abc', '#cos-input=7bd480b6-1234-4567-89ab-123456789abc'])(
    'keeps a retained command marker out of the blank Desktop reuse proof: %s', async marker => {
    dom.window.history.replaceState({}, '', '/app' + marker);
    let listener: any = null;
    const win: any = dom.window;
    win.CLF_TEST_HOOK = () => {};
    win.chrome = {
      runtime: { id: 'gemini-extension-test', sendMessage: async (message: any) => {
        if (message.type === 'gemini_approval_receipts') return { ok: true, receipts: [] };
        if (message.type === 'status') return { connected: true, paired: true };
        if (message.type === 'redeem') return { ok: true, command: null };
        if (message.type === 'activity') return { ok: true, data: { entries: [], cursor: 0 } };
        if (message.type === 'settings_get') return { ok: true, data: {} };
        return { ok: true, pending: 0, durable: true };
      }, onMessage: { addListener(value: any) { listener = value; }, removeListener() {} } },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } }
    };
    win.eval(recorderSource); await vi.advanceTimersByTimeAsync(1000);
    let reply: any = null;
    listener({ type: 'clf-input-reuse-state' }, {}, (value: any) => { reply = value; });
    expect(reply).toMatchObject({ safe: !marker });
    expect(api.messages()).toEqual([]); expect(box.textContent).toBe('');
    expect(dom.window.location.href).toBe('https://gemini.google.com/app' + marker);
  });
  it.each([
    ['blank-complete', 'completed'], ['incomplete', null], ['busy', null], ['pending', null],
    ['error', 'failed'], ['cancel', 'stopped'], ['history-only', null]
  ] as const)('settles only the exact native terminal response while retaining error/cancel priority: %s', async (mode, outcome) => {
    const sent: any[] = []; let hook: any = null;
    const win: any = dom.window, nativeTurnId = 'g-owned-native-empty';
    win.Date.now = () => Date.now();
    const old = document.createElement('model-response');
    old.innerHTML = '<message-content>Historical completed answer</message-content><div class="response-footer complete"></div>';
    const question = document.createElement('user-query'); question.id = 'owned-current-question';
    question.innerHTML = '<div class="query-text"><p>Current accepted task</p></div>';
    const response = document.createElement('model-response'); response.id = 'owned-current-response';
    response.innerHTML = '<message-content></message-content>' + (mode === 'incomplete' ? '' : '<div class="response-footer complete gap"></div>');
    if (mode === 'busy') response.querySelector('message-content')!.setAttribute('aria-busy', 'true');
    document.querySelector('main')!.prepend(old, question);
    if (mode !== 'history-only') question.after(response);
    if (mode === 'pending') response.append(card('apply patch').element);
    if (mode === 'error') {
      const error = document.createElement('div'); error.setAttribute('role', 'alert'); error.textContent = 'Native failure fixture'; document.body.append(error);
    }
    let stop: HTMLButtonElement | null = null;
    if (mode === 'cancel') { stop = document.createElement('button'); stop.setAttribute('aria-label', 'Stop response'); document.body.append(stop); }
    const listeners = vi.spyOn(document, 'addEventListener');
    win.CLF_TEST_HOOK = (value: any) => { hook = value; };
    win.chrome = {
      runtime: { id: 'gemini-extension-test', sendMessage: async (message: any) => {
        if (message.type === 'gemini_approval_receipts') return { ok: true, receipts: [] };
        sent.push(message);
        if (message.type === 'status') return { connected: true, paired: true };
        if (message.type === 'activity') return { ok: true, data: { entries: [], stream: [], nextSince: 0,
          activeTurnId: nativeTurnId, recordedTurnId: nativeTurnId, recordedQuestionId: `gemini:${id}:user:owned-current-question`, pendingTools: 0 } };
        if (message.type === 'settings_get') return { ok: true, data: {} };
        return { ok: true, pending: 0, durable: true };
      }, onMessage: { addListener() {}, removeListener() {} } },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } }
    };
    win.eval(recorderSource); await vi.advanceTimersByTimeAsync(1000);
    expect(hook).not.toBeNull();
    if (mode === 'cancel') {
      const stopListener = listeners.mock.calls.find(call => call[0] === 'click' && (call[1] as Function)?.name === 'noteStopClick')?.[1] as EventListener;
      expect(stopListener).toBeDefined(); stopListener({ isTrusted: true, target: stop } as unknown as Event); stop!.remove();
    }
    hook.observe(); await vi.advanceTimersByTimeAsync(hook.TURN_SETTLE_MS + 100); hook.observe(); await hook.flush();
    const observations = sent.filter(message => message.type === 'events').flatMap(message => (message.entries || []).map((entry: any) => entry.event));
    const ends = observations.filter((event: any) => event.kind === 'turn_end');
    expect(ends, JSON.stringify(observations.map((event: any) => ({ kind: event.kind, turnId: event.turnId, chars: event.text?.length, outcome: event.outcome })))).toHaveLength(outcome ? 1 : 0);
    if (outcome) expect(ends[0]).toMatchObject({ turnId: nativeTurnId, outcome });
    if (mode === 'blank-complete') expect(ends[0].detail).toBe('Gemini completed the native response without visible answer text.');
    expect(observations.filter((event: any) => event.kind === 'turn_start')).toHaveLength(0);
    expect(observations.some((event: any) => event.kind === 'tool_call')).toBe(false);
    expect(observations.some((event: any) => event.kind === 'assistant_message' && event.text === 'Historical completed answer' && event.turnId === nativeTurnId)).toBe(false);
  });
  it.each([['worker', true, false, false], ['resume', true, false, false], ['resume', false, false, false],
    ['worker', true, true, false], ['worker', true, false, true], ['resume', true, false, true],
    ['worker', true, false, false, true], ['worker', true, false, false, false, true],
    ['resume', true, false, false, false, true], ['resume', true, false, false, true],
    ['resume', true, false, false, false, false, true],
    ['worker', true, false, false, false, false, false, true],
    ['resume', true, false, false, false, false, false, true],
    ['resume', true, false, false, true, false, false, true]] as const)(
    'binds a redeemed %s command after warm-up and spends its real task dispatch only when permitted=%s (native initial remount=%s, native Skill=%s, human draft=%s, static reinjection=%s, lost dispatch reply=%s, warm-up remount=%s)', async (kind, permit, remount, webSkill, humanDraft: boolean = false, reinjection: boolean = false, lostDispatchReply: boolean = false, warmupRemount: boolean = false) => {
    const commandId = '1234567890abcdef', token = 'scratch_resume_marker_123456789';
    const authoredTask = kind === 'resume' ? `[[CLF-RESUME:${token}]]\n\nContinue the scratch task.` : 'Perform the scratch worker task.';
    const task = webSkill ? prependUserPrompt(authoredTask, '@gemini-code\n\nPlatform: win32.') : authoredTask;
    dom.window.history.replaceState({}, '', `/app?clf=${commandId}`);
    const sent: any[] = [], nativeSends: string[] = []; let client: string | null = null;
    const win: any = dom.window;
    win.CLF_TEST_HOOK = () => {};
    win.chrome = {
      runtime: { id: 'gemini-extension-test', sendMessage: async (message: any) => {
        if (message.type === 'gemini_approval_receipts') return { ok: true, receipts: [] };
        sent.push(message);
        if (message.type === 'redeem') {
          expect(message.id).toBe(commandId); client = message.client;
          if (reinjection) { win.eval(source); win.eval(recorderSource); }
          return { ok: true, command: { id: commandId, type: kind, text: task, ...(kind === 'worker' ? { agent: 'scratch-worker' } : {}), expiresAt: Date.now() + 360000 }, rendering: { ready: false, error: 'permission_unavailable' } };
        }
        if (message.type === 'gemini_binding') {
          expect(message).toMatchObject({ conversation_id: id, command: { id: commandId, client } });
          expect(message.opening).toBeUndefined(); expect(message.input).toBeUndefined(); expect(nativeSends).toHaveLength(1);
          return { ok: true, data: binding() };
        }
        if (message.type === 'compact' && (message.destinationAttempt || message.destinationDispatch)) {
          expect(nativeSends).toHaveLength(1); expect(api.confirmedMention('OneCode')).toBe(true);
          expect(api.composerAuthoredText()).toBe(task);
          expect(message).toMatchObject({ token, commandId, client, conversationId: id });
          if (message.destinationDispatch && lostDispatchReply) return { ok: false, error: 'transport-reply-lost' };
          return { ok: true, data: message.destinationAttempt ? { allowed: permit } : { armed: true } };
        }
        if (message.type === 'status') return { connected: true, paired: true, connectorNames: { core: 'OneCode' } };
        if (message.type === 'activity') return { ok: true, data: { entries: [], cursor: 0 } };
        if (message.type === 'settings_get') return { ok: true, data: {} };
        return { ok: true, data: { ok: true }, pending: 0, durable: true };
      }, onMessage: { addListener() {}, removeListener() {} } },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } }
    };
    nativeStrongMenu(webSkill);
    if (warmupRemount) {
      const edit = document.execCommand;
      document.execCommand = (command, ui, value) => {
        const done = edit(command, ui, value);
        if (value === warmup && !nativeSends.length) {
          const button = document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement; button.disabled = true;
          setTimeout(() => {
            const replacement = box.cloneNode(true) as HTMLElement;
            box.replaceWith(replacement); box = replacement; button.disabled = false;
            if (humanDraft) box.textContent = 'A human draft in the new editor';
          }, 200);
        }
        return done;
      };
    }
    if (remount) {
      const edit = document.execCommand;
      document.execCommand = (command, ui, value) => {
        const done = edit(command, ui, value);
        if (value === task && !nativeSends.length) {
          const button = document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement; button.disabled = true;
          setTimeout(() => {
            const replacement = box.cloneNode(true) as HTMLElement;
            box.replaceWith(replacement); box = replacement; button.disabled = false;
          }, 200);
        }
        return done;
      };
    }
    document.querySelector('button')!.addEventListener('click', () => {
      const raw = box.cloneNode(true) as HTMLElement; nativeSends.push(raw.textContent || '');
      const user = document.createElement('user-query'), content = document.createElement('div');
      user.id = nativeSends.length === 1 ? 'warm-up' : 'actual-command'; content.className = 'query-text';
      content.append(...[...raw.childNodes]); user.append(content); document.querySelector('main')!.append(user); box.replaceChildren();
      if (nativeSends.length === 1) {
        expect(nativeSends[0]).toBe((webSkill ? '@gemini-code ' : '') + warmup);
        expect(sent.some(message => message.type === 'compact')).toBe(false);
        expect(sent.some(message => message.type === 'ack' && message.status === 'sent')).toBe(false);
        dom.window.history.replaceState({}, '', `/app/${id}`); // Native warm-up consumes the opening marker.
        // Native route observation runs while the warm-up is generating. A
        // synchronous READY masks the fresh-command epoch transition.
        setTimeout(() => {
          // The native conversation mount replaces the fresh editing host.
          const replacement = box.cloneNode(false) as HTMLElement;
          box.replaceWith(replacement); box = replacement;
          if (humanDraft) box.textContent = 'A human draft in the new editor';
          const response = document.createElement('model-response'); response.id = 'warm-ready'; response.textContent = 'READY'; user.after(response);
        }, 1000);
      }
    });
    win.eval(recorderSource); await vi.advanceTimersByTimeAsync(10000);
    expect(nativeSends, JSON.stringify(sent.map(message => ({ type: message.type, error: message.error, step: message.step,
      status: message.status, conversationId: message.conversationId })))).toHaveLength(warmupRemount && humanDraft ? 0 : permit && !humanDraft && !lostDispatchReply ? 2 : 1);
    const acknowledgements = sent.filter(message => message.type === 'ack' && message.status === 'sent');
    expect(acknowledgements).toHaveLength(permit && !humanDraft && !lostDispatchReply ? 1 : 0);
    if (permit && !humanDraft && !lostDispatchReply) expect(acknowledgements[0]).toMatchObject({ id: commandId, conversationId: id, client });
    const dispatches = sent.filter(message => message.type === 'compact' && message.destinationDispatch);
    expect(dispatches).toHaveLength(kind === 'resume' && permit && !humanDraft ? 1 : 0);
    expect(api.preparedConversation()).toBeNull();
    if (humanDraft) expect(box.textContent).toBe('A human draft in the new editor');
    if (kind === 'resume' && (!permit || humanDraft)) {
      expect(sent.filter(message => message.type === 'ack' && message.status === 'failed')).toHaveLength(1);
    }
    if (lostDispatchReply) expect(sent.filter(message => message.type === 'ack')).toHaveLength(0);
  });
  it.each([
    { fresh: true, outcome: 'sent', delayedWarmupModel: true }, { fresh: true, outcome: 'sent', delayedWarmupModel: false },
    { fresh: false, outcome: 'sent', delayedWarmupModel: false },
    { fresh: true, outcome: 'binding-refused', delayedWarmupModel: false },
    { fresh: false, outcome: 'binding-refused', delayedWarmupModel: false },
    { fresh: false, outcome: 'menu-unavailable', delayedWarmupModel: false }, { fresh: false, outcome: 'authorization-refused', delayedWarmupModel: false },
    { fresh: true, outcome: 'sent', delayedWarmupModel: true, accountPrefix: '/u/0' },
    { fresh: false, outcome: 'sent', delayedWarmupModel: false, accountPrefix: '/u/0' },
    { fresh: true, outcome: 'sent', delayedWarmupModel: true, accountPrefix: '/u/1', webSkill: true },
    { fresh: true, outcome: 'binding-refused', delayedWarmupModel: false, accountPrefix: '/u/1', webSkill: true },
    { fresh: true, outcome: 'sent', delayedWarmupModel: false, accountPrefix: '/u/1', requestedModel: 'gemini-current' },
    { fresh: true, outcome: 'sent', delayedWarmupModel: false, accountPrefix: '/u/1', requestedModel: nativeModelChoices[1].id },
    { fresh: false, outcome: 'sent', delayedWarmupModel: false, escapedReadback: true }
  ])('keeps Desktop draft custody and reports a proven preparation failure: $outcome (fresh=$fresh, delayed warm-up model=$delayedWarmupModel, model=$requestedModel, escaped=$escapedReadback)', async ({ fresh, outcome, delayedWarmupModel, accountPrefix = '', webSkill = false, requestedModel, escapedReadback = false }) => {
    const requiredConnector = outcome === 'menu-unavailable' ? 'OneCode Core (Test PC)' : 'OneCode';
    const inputId = '878ec7a1-9be1-477e-a073-3db6b8d56b92', owner = '10:document-test:0';
    const task = escapedReadback ? prependUserPrompt('Verify [byte[]](0x68,0x69).', 'Local skills: read /skills/.catalog.json.\nUse the configured Core connector.') : webSkill ? prependUserPrompt('Original Desktop task', '@gemini-code\n\nPlatform: win32.') : 'Original Desktop task';
    dom.window.history.replaceState({}, '', fresh ? `${accountPrefix}/app?cos-input=${inputId}` : `${accountPrefix}/app/${id}`);
    const sent: any[] = [], nativeSends: string[] = []; let listener: any = null;
    const bindingDiagnostic = vi.spyOn(dom.window.console, 'info').mockImplementation(() => {});
    const inputClaims = vi.spyOn(api, 'setInputClaim');
    const win: any = dom.window;
    win.CLF_TEST_HOOK = () => {};
    win.chrome = {
      runtime: { id: 'gemini-extension-test', sendMessage: async (message: any) => {
        if (message.type === 'gemini_approval_receipts') return { ok: true, receipts: [] };
        sent.push(message);
        if (message.type === 'status') return { connected: true, paired: true, connectorNames: { core: requiredConnector, desktop: 'OneCode Desktop', plugins: 'OneCode Plugins' } };
        if (message.type === 'activity') return { ok: true, data: { entries: [], cursor: 0 } };
        if (message.type === 'settings_get') return { ok: true, data: {} };
        if (message.type === 'gemini_binding') {
          expect(message.opening).toEqual(fresh ? { id: inputId, owner } : undefined);
          expect(message.input).toEqual({ id: inputId, owner });
          expect(message.command).toBeUndefined();
          expect(nativeSends).toHaveLength(fresh ? 1 : 0);
          if (outcome === 'binding-refused') return { ok: false, status: 409, data: { error: 'gemini_opening_not_owned' } };
          return { ok: true, data: binding({ connector_name: requiredConnector }) };
        }
        if (message.type === 'desktop_input') {
          if (message.authorize) {
            expect(nativeSends).toHaveLength(fresh ? 1 : 0);
            expect(message.conversationId).toBe(id);
            expect(message.owner).toBe(owner);
            expect(api.confirmedMention('OneCode')).toBe(true);
            return { ok: true, data: { ok: outcome !== 'authorization-refused' } };
          }
          if (message.fail) return { ok: true, data: { ok: true } };
          if (message.ack) return { ok: true, data: { ok: true } };
          return { ok: true, data: { input: { id: inputId, owner, text: task, images: [], attachments: [], opening: fresh,
            model: requestedModel, reasoningEffort: null } } };
        }
        return { ok: true, pending: 0, durable: true };
      }, onMessage: { addListener(value: any) { listener = value; }, removeListener() {} } },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } }
    };
    if (outcome !== 'menu-unavailable') nativeStrongMenu(webSkill);
    let nativeModel = '', modelRevision = 0;
    if (delayedWarmupModel) {
      const edit = document.execCommand;
      document.execCommand = (command, ui, value) => {
        const done = edit(command, ui, value);
        if (nativeSends.length) return done;
        const revision = ++modelRevision, next = box.textContent || '';
        const button = document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
        button.disabled = !nativeModel; // Send reads the prior framework model, not this new DOM.
        setTimeout(() => {
          if (revision !== modelRevision) return;
          nativeModel = next; button.disabled = !nativeModel;
        }, 50);
        return done;
      };
    }
    document.querySelector('button')!.addEventListener('click', () => {
      const raw = box.cloneNode(true) as HTMLElement;
      if (escapedReadback) {
        const walker = document.createTreeWalker(raw, dom.window.NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) if (!(node.parentElement?.closest('strong')))
          node.textContent = node.textContent!.replace(/[!-/:-@[-`{-~]/g, '\\$&').replace(/\n/g, '\n ');
      }
      if (delayedWarmupModel && !nativeSends.length) raw.replaceChildren(document.createTextNode(nativeModel));
      nativeSends.push(raw.textContent || '');
      const user = document.createElement('user-query'), content = document.createElement('div');
      user.id = fresh && nativeSends.length === 1 ? 'warm-up' : 'actual-task'; content.className = 'query-text';
      const nativeLabel = document.createElement('h5'); nativeLabel.className = 'cdk-visually-hidden screen-reader-user-query-label';
      nativeLabel.innerHTML = '<span>You said</span> @OneCode Original Desktop…'; content.append(nativeLabel);
      content.append(...[...raw.childNodes]); user.append(content); document.querySelector('main')!.append(user); box.replaceChildren();
      if (fresh && nativeSends.length === 1) {
        expect(nativeSends[0]).toBe((webSkill ? '@gemini-code ' : '') + warmup);
        expect(nativeSends[0]).not.toContain('Original Desktop task');
        expect(sent.some(message => message.type === 'desktop_input' && message.authorize)).toBe(false);
        nativeModel = ''; modelRevision++;
        dom.window.history.replaceState({}, '', `${accountPrefix}/app/${id}`);
        const response = document.createElement('model-response'); response.id = 'warm-ready'; response.textContent = 'READY'; user.after(response);
      }
    });
    win.eval(recorderSource);
    await vi.advanceTimersByTimeAsync(1000);
    const result = new Promise(resolve => listener({ type: 'clf-desktop-input', id: inputId, conversationId: fresh ? null : id }, {}, resolve));
    if (escapedReadback) {
      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toEqual({ ok: true });
      const events = sent.filter(message => message.type === 'events').flatMap(message => message.entries.map((entry: any) => entry.event));
      expect(events.filter((event: any) => event.kind === 'turn_start'), 'the accepted input must publish its turn without another background timer').toHaveLength(1);
      const question = events.findIndex((event: any) => event.kind === 'user_message' && event.messageId === `gemini:${id}:user:actual-task`);
      const start = events.findIndex((event: any) => event.kind === 'turn_start');
      expect(question, 'the exact accepted question must precede its turn, even with an escaped transport frame').toBeGreaterThanOrEqual(0);
      expect(question).toBeLessThan(start);
    }
    if (requestedModel) {
      await vi.advanceTimersByTimeAsync(300);
      expect(sent.some(message => message.type === 'desktop_input' && (message.authorize || message.fail))).toBe(false);
      expect(nativeSends).toEqual([]); expect(box.textContent).toBe('');
      nativeModePicker();
    }
    await vi.advanceTimersByTimeAsync(outcome === 'menu-unavailable' ? 12000 : 10000);
    if (webSkill) expect(sent.some(message => message.type === 'gemini_binding')).toBe(true);
    expect(await result).toEqual({ ok: outcome === 'sent' });
    expect(inputClaims.mock.calls).toEqual([[{ id: inputId, owner }], [null]]);
    expect(nativeSends).toHaveLength((fresh ? 1 : 0) + (outcome === 'sent' ? 1 : 0));
    const authorize = sent.filter(message => message.type === 'desktop_input' && message.authorize);
    const acknowledgements = sent.filter(message => message.type === 'desktop_input' && message.ack);
    expect(authorize).toHaveLength(outcome === 'sent' || outcome === 'authorization-refused' ? 1 : 0);
    expect(acknowledgements).toHaveLength(outcome === 'sent' ? 1 : 0);
    if (outcome === 'sent') expect(acknowledgements[0]).toMatchObject({ conversationId: id, owner, messageId: `gemini:${id}:user:actual-task` });
    const failures = sent.filter(message => message.type === 'desktop_input' && message.fail);
    expect(failures).toHaveLength(outcome === 'menu-unavailable' || outcome === 'binding-refused' ? 1 : 0);
    if (outcome === 'menu-unavailable') {
      expect(failures[0]).toMatchObject({ id: inputId, owner, error: `Gemini's @ menu did not contain the required connector "${requiredConnector}". In OneCode Setup, connect the current Core URL using the same Google account, then retry. Nothing was submitted for this task.` });
      expect(box.textContent).toBe('');
      expect(JSON.stringify(failures)).not.toContain(key);
    }
    if (outcome === 'binding-refused') {
      const line = String(bindingDiagnostic.mock.calls.find(([line]) => String(line).startsWith('[OneCode binding] '))?.[0]);
      const evidence = JSON.parse(line.slice('[OneCode binding] '.length));
      expect(evidence).toMatchObject({ conversationId: id, openingPresent: fresh, inputPresent: true, commandPresent: false, preparedMatches: fresh,
        callerCurrent: true, routeMatches: true, status: 409, workerError: null, httpError: 'gemini_opening_not_owned' });
      expect(line).not.toContain(key); expect(line).not.toContain(owner); expect(line).not.toContain('Original Desktop task');
      expect(failures[0].error).toContain('session-binding-unavailable');
    }
  });
  it('does not claim a generation before its malformed native question can be recorded', async () => {
    const task = prependUserPrompt('Actual task', 'Use the configured Core connector.');
    turn('user', task.replace(/\n/g, '\n '), 'unaccepted-task');
    const stop = document.createElement('button'); stop.ariaLabel = 'Stop response'; document.body.append(stop);
    const win: any = dom.window, sent: any[] = [];
    win.CLF_TEST_HOOK = () => {};
    win.chrome = {
      runtime: { id: 'gemini-extension-test', sendMessage: async (message: any) => {
        sent.push(message);
        if (message.type === 'gemini_approval_receipts') return { ok: true, receipts: [] };
        if (message.type === 'status') return { connected: true, paired: true };
        if (message.type === 'activity') return { ok: true, data: { entries: [], userAnchors: [], nextSince: 0 } };
        if (message.type === 'settings_get') return { ok: true, data: {} };
        return { ok: true, pending: 0, durable: true };
      }, onMessage: { addListener() {}, removeListener() {} } },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } }
    };
    win.eval(recorderSource);
    await vi.advanceTimersByTimeAsync(10000);
    const events = sent.filter(message => message.type === 'events').flatMap(message => message.entries.map((entry: any) => entry.event));
    expect(events.filter((event: any) => event.kind === 'user_message' || event.kind === 'turn_start')).toEqual([]);
  });
  it.each(['native busy', 'local tools busy', 'foreign question', 'unresolved permission'] as const)(
    'uses native same-question evidence before automatic Compact Stop instead of waiting for Fiber: %s', async mode => {
    const token = 'automatic-native-handoff-1234', prompt = `[[CLF-HANDOFF:${token}]]\n\nWrite the Markdown handoff and call save_handoff.`;
    const win: any = dom.window, sent: any[] = []; let hook: any, stopped = 0, sends = 0, filed = false, tools = mode === 'local tools busy' ? 1 : 0;
    const native = document.createElement('div'); native.className = 'conversation-container'; native.id = '1111222233334444';
    native.innerHTML = '<user-query><div class="query-text">Original native task</div></user-query><model-response><message-content>Working on the original task</message-content></model-response>';
    document.querySelector('main')!.prepend(native);
    const stop = document.createElement('button'); stop.ariaLabel = 'Stop response'; stop.textContent = 'Stop'; document.body.append(stop);
    stop.addEventListener('click', () => { expect(tools).toBe(0); stopped++; stop.remove(); });
    if (mode === 'unresolved permission') card('foreign tool', 'Another app');
    win.CLF_TEST_HOOK = (value: any) => { hook = value; };
    win.chrome = { runtime: { id: 'gemini-extension-test', sendMessage: async (message: any) => {
      sent.push(message);
      if (message.type === 'gemini_approval_receipts') return { ok: true, receipts: [] };
      if (message.type === 'status') return { connected: true, paired: true, connectorNames: { core: 'OneCode' } };
      if (message.type === 'settings_get') return { ok: true, data: {} };
      if (message.type === 'activity') {
        if (filed && mode === 'foreign question' && !document.querySelector('#foreign-question')) {
          const other = document.createElement('div'); other.className = 'conversation-container'; other.id = '5555666677778888';
          other.innerHTML = '<user-query id="foreign-question"><div class="query-text">A different actual question</div></user-query>'; document.querySelector('main')!.append(other);
        }
        return { ok: true, data: { entries: [], nextSince: 0, pendingTools: tools } };
      }
      if (message.type === 'gemini_binding') return { ok: true, data: binding({ enabled_tools: ['save_handoff'] }) };
      if (message.type === 'compact') {
        if (message.cancel) return { ok: true, data: { cancelled: true } };
        if (message.sourceAttempt) return { ok: true, data: { allowed: true } };
        if (message.sourceDispatch) return { ok: true, data: { armed: true } };
        if (message.sourceMessageId) return { ok: true, data: { bound: true } };
        if (message.ticket) filed = true;
        return { ok: true, data: { token, prompt: message.ticket ? null : prompt,
          sourceSend: { state: 'not-attempted', messageId: null } } };
      }
      return { ok: true, pending: 0, durable: true };
    }, onMessage: { addListener() {}, removeListener() {} } }, storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } } };
    nativeStrongMenu();
    document.querySelector('button[aria-label="Send message"]')!.addEventListener('click', () => {
      sends++;
      const row = document.createElement('div'); row.className = 'conversation-container'; row.id = 'aabbccddeeff0011';
      const user = document.createElement('user-query'), text = document.createElement('div'); text.className = 'query-text';
      text.append(...[...box.cloneNode(true).childNodes]); user.append(text); row.append(user); document.querySelector('main')!.append(row); box.replaceChildren();
    });
    win.eval(recorderSource); await vi.advanceTimersByTimeAsync(1000);
    const operation = hook.startCompact(true);
    if (mode === 'local tools busy') { await vi.advanceTimersByTimeAsync(1500); expect(stopped).toBe(0); tools = 0; }
    if (mode === 'unresolved permission') {
      await vi.advanceTimersByTimeAsync(5000); expect(stopped).toBe(0); expect(sends).toBe(0); await hook.cancelCompact();
    }
    await vi.advanceTimersByTimeAsync(20000); await operation;
    const allowed = mode === 'native busy' || mode === 'local tools busy';
    expect(stopped).toBe(allowed ? 1 : 0); expect(sends).toBe(allowed ? 1 : 0);
    expect(sent.some(message => message.type === 'repair_fiber')).toBe(false);
    if (!allowed) expect(sent.some(message => message.type === 'compact' && (message.sourceAttempt || message.sourceDispatch))).toBe(false);
  });
  it.each(['accepted', 'escaped readback', 'lost receipt', 'foreign route', 'foreign edit', 'foreign attachment'] as const)('binds Compact & Resume to the actual Gemini source Send receipt without Fiber or prose capture: %s', async mode => {
    const token = 'native-handoff-test-123456', exchange = 'aabbccddeeff0011';
    const prompt = `[[CLF-HANDOFF:${token}]]\n\nWrite the Markdown handoff and call save_handoff.`;
    let hook: any, sends = 0, receiptCalls = 0;
    const sent: any[] = [], win: any = dom.window;
    const job = { sessionId: 'local-session-test', token, stage: 'handoff-pending', busy: true, handoffId: null, error: null,
      sourceSend: { state: 'dispatched-unresolved', messageId: null } };
    win.CLF_TEST_HOOK = (value: any) => { hook = value; };
    win.chrome = { runtime: { id: 'gemini-extension-test', sendMessage: async (message: any) => {
      sent.push(message);
      if (message.type === 'gemini_approval_receipts') return { ok: true, receipts: [] };
      if (message.type === 'status') return { connected: true, paired: true, connectorNames: { core: 'OneCode' } };
      if (message.type === 'settings_get') return { ok: true, data: {} };
      if (message.type === 'activity') return { ok: true, data: { entries: [], nextSince: 0, pendingTools: 0,
        ...(mode === 'lost receipt' && sends > 0 ? { job } : {}) } };
      if (message.type === 'gemini_binding') return { ok: true, data: binding({ enabled_tools: ['save_handoff'] }) };
      if (message.type === 'compact') {
        if (message.sourceAttempt) return { ok: true, data: { allowed: true } };
        if (message.sourceDispatch) {
          if (mode === 'foreign route') win.history.replaceState({}, '', '/app/ffffffffffffffff');
          if (mode === 'foreign edit') box.textContent = 'Preserve this new person-owned draft';
          if (mode === 'foreign attachment') nativeAttachment('keep.png');
          return { ok: true, data: { armed: true } };
        }
        if (message.sourceMessageId) {
          receiptCalls++;
          const observations = sent.filter(row => row.type === 'events').flatMap(row => row.entries.map((entry: any) => entry.event));
          expect(observations.some(row => row.kind === 'user_message' && row.messageId === message.sourceMessageId)).toBe(true);
          if (mode === 'lost receipt' && receiptCalls === 1) return { ok: false, status: 503, data: { retryable: true } };
          return { ok: true, data: { bound: true, job } };
        }
        if (message.ticket) return { ok: true, data: { token, sourceSend: { state: 'not-attempted', messageId: null }, job } };
        return { ok: true, data: { token, prompt, sourceSend: { state: 'not-attempted', messageId: null }, job } };
      }
      return { ok: true, pending: 0, durable: true };
    }, onMessage: { addListener() {}, removeListener() {} } }, storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } } };
    nativeStrongMenu();
    document.querySelector('button[aria-label="Send message"]')!.addEventListener('click', () => {
      sends++;
      const row = document.createElement('div'); row.className = 'conversation-container'; row.id = exchange;
      const user = document.createElement('user-query'); const text = document.createElement('div'); text.className = 'query-text';
      text.append(...[...box.cloneNode(true).childNodes]); user.append(text);
      if (mode === 'escaped readback') {
        const walker = document.createTreeWalker(text, win.NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.parentElement?.closest('strong')) node.textContent = node.textContent!.replace(/[!-/:-@[-`{-~]/g, '\\$&');
        }
      }
      const answer = document.createElement('model-response'); answer.innerHTML = '<message-content>A complete prose answer is not a saved file.</message-content><div class="response-footer complete"></div>';
      row.append(user, answer); document.querySelector('main')!.append(row); box.replaceChildren();
    });
    win.eval(recorderSource); await vi.advanceTimersByTimeAsync(1000); hook.injectControl();
    const operation = hook.startCompact(); await vi.advanceTimersByTimeAsync(20000); await operation;
    if (mode === 'lost receipt') { await hook.pullActivity(); await vi.advanceTimersByTimeAsync(1000); }
    const compacts = sent.filter(row => row.type === 'compact');
    expect(sends).toBe(mode === 'accepted' || mode === 'escaped readback' || mode === 'lost receipt' ? 1 : 0);
    const receipts = compacts.filter(row => row.sourceMessageId);
    if (mode === 'accepted' || mode === 'escaped readback' || mode === 'lost receipt') {
      expect(receipts.length).toBeGreaterThan(0);
      expect(receipts.every(row => row.conversationId === id && row.token === token && row.sourceMessageId === `gemini:${id}:user:${exchange}`)).toBe(true);
      if (mode === 'lost receipt') expect(receipts.length).toBeGreaterThan(1);
    } else expect(receipts).toEqual([]);
    expect(compacts.some(row => typeof row.summary === 'string')).toBe(false);
    expect(sent.some(row => row.type === 'repair_fiber')).toBe(false);
    if (mode === 'foreign edit') expect(box.textContent).toBe('Preserve this new person-owned draft');
    if (mode === 'foreign attachment') expect(api.hasComposerAttachments()).toBe(true);
  });
  it('keeps existing controls and records authored Gemini messages without leaking binding metadata', async () => {
    const sent: any[] = []; let hook: any = null;
    const win: any = dom.window;
    win.CLF_TEST_HOOK = (value: any) => { hook = value; };
    win.chrome = {
      runtime: { id: 'gemini-extension-test', sendMessage: async (message: any) => {
        if (message.type === 'gemini_approval_receipts') return { ok: true, receipts: [] };
        sent.push(message);
        if (message.type === 'status') return { connected: true, paired: true, connectorNames: { core: 'OneCode', desktop: 'OneCode Desktop', plugins: 'OneCode Plugins' } };
        if (message.type === 'activity') return { ok: true, data: { entries: [], cursor: 0 } };
        if (message.type === 'settings_get') return { ok: true, data: {} };
        return { ok: true, pending: 0, durable: true };
      }, onMessage: { addListener() {}, removeListener() {} } },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {}, removeListener() {} } }
    };
    turn('user', 'Native Gemini task' + frame, 'native-user');
    const response = document.createElement('model-response'); response.innerHTML = '<message-content id="message-content-id-r_1234567890abcdef">Native answer</message-content><div class="response-footer complete"></div>';
    document.querySelector('main')!.append(response);
    win.eval(recorderSource);
    await vi.advanceTimersByTimeAsync(1000);
    expect(hook).not.toBeNull();
    hook.injectControl(); hook.observe(); await hook.flush();
    expect(document.querySelector('[data-clf-composer]')).not.toBeNull();
    const observations = sent.filter(message => message.type === 'events').flatMap(message => (message.entries || []).map((entry: any) => entry.event));
    expect(JSON.stringify(observations)).toContain('Native Gemini task');
    expect(JSON.stringify(observations)).toContain('Native answer');
    expect(JSON.stringify(observations)).not.toContain(key);
    expect(sent.some(message => message.type === 'repair_fiber')).toBe(false);
  });
});
