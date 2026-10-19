import type { ArtifactFile, ArtifactOpenRequest, ArtifactSnapshot, ArtifactSummary } from '../shared/artifact.js';
import { createProjectCodeEditor, createProjectDiffViewer, type ProjectCodeEditor, type ProjectDiffViewer } from './file-code-editor.js';
import { createArtifactPreview, type ArtifactPreviewHandle } from './artifact-preview.js';
import { el, icon, run, toast } from './dom.js';
import { t, ui } from './i18n.js';
import type { createWorkspaceDocks } from './workspace-docks.js';

type Docks = ReturnType<typeof createWorkspaceDocks>;
type Mode = 'code' | 'diff' | 'preview';

interface Draft { revision: number; text: string }

function surfaceId(id: string): string { return `artifact:${id}`; }
function baseName(path: string): string { return path.split('/').at(-1) ?? path; }
function artifactIcon(summary: ArtifactSummary): string {
  return summary.kind === 'web' ? 'i-browser' : summary.kind === 'diagram' ? 'i-chart' : 'i-file-text';
}
function summaryFrom(snapshot: ArtifactSnapshot): ArtifactSummary {
  const value = snapshot.artifact;
  return { id: value.id, sessionId: value.sessionId, ...(value.projectId ? { projectId: value.projectId } : {}),
    title: value.title, kind: value.kind, headRevision: value.headRevision, retainedFromRevision: value.retainedFromRevision,
    ...(value.entrypoint ? { entrypoint: value.entrypoint } : {}), updatedAt: value.updatedAt, origin: value.origin, capabilities: value.capabilities };
}

export function createArtifactPanel(options: {
  docks: Docks;
  selectedSession: () => string | null;
  selectSession: (id: string) => void;
}) {
  const pane = el('section', 'file-panel artifact-panel'); pane.hidden = true;
  const toolbar = el('div', 'file-panel-toolbar artifact-toolbar');
  const title = el('strong', 'artifact-title');
  const revision = el('span', 'meta artifact-revision');
  const fileSelect = document.createElement('select'); fileSelect.className = 'artifact-file-select';
  const modeActions = el('div', 'artifact-mode-actions');
  const modeButtons = new Map<Mode, HTMLButtonElement>();
  const body = el('div', 'file-panel-body artifact-body');
  const head = el('div', 'file-preview-head artifact-editor-head');
  const fileLabel = el('div', 'file-preview-title');
  const dirtyLabel = el('span', 'file-editor-dirty'); dirtyLabel.hidden = true;
  const language = el('span', 'file-editor-language');
  const actions = el('div', 'file-preview-actions');
  const copy = el('button', 'tool-copy', () => t('Copy')) as HTMLButtonElement; copy.type = 'button';
  const save = el('button', 'btn file-panel-action') as HTMLButtonElement; save.type = 'button';
  save.append(icon('i-file'), el('span', '', () => t('Save')));
  const exportButton = el('button', 'btn file-panel-action') as HTMLButtonElement; exportButton.type = 'button';
  exportButton.append(icon('i-out'), el('span', '', () => t('Save to project')));
  const reload = el('button', 'btn file-panel-action') as HTMLButtonElement; reload.type = 'button'; reload.hidden = true;
  reload.append(icon('i-retry'), el('span', '', () => t('Reload')));
  actions.append(copy, save, exportButton, reload);
  head.append(fileLabel, dirtyLabel, language, actions);
  const content = el('div', 'file-code-editor-host artifact-content');
  const status = el('p', 'meta artifact-status'); status.hidden = true;
  body.append(head, content, status); pane.append(toolbar, body);

  for (const next of ['preview', 'code', 'diff'] as const) {
    const button = el('button', 'btn file-panel-action', () => t(next[0]!.toUpperCase() + next.slice(1))) as HTMLButtonElement;
    button.type = 'button'; button.dataset.mode = next; button.addEventListener('click', () => void setMode(next));
    modeButtons.set(next, button); modeActions.append(button);
  }
  toolbar.append(title, revision, fileSelect, modeActions);

  let sessionId: string | null = null;
  let summaries = new Map<string, ArtifactSummary>();
  let registered = new Set<string>();
  let generation = 0;
  let current: ArtifactSnapshot | null = null;
  let currentArtifactId: string | null = null;
  let currentPath = '';
  let mode: Mode = 'code';
  let editor: ProjectCodeEditor | null = null;
  let diff: ProjectDiffViewer | null = null;
  let preview: ArtifactPreviewHandle | null = null;
  let editorDraft = '';
  let editorDirty = false;
  let conflict = false;
  const drafts = new Map<string, Map<string, Draft>>();
  const openedRevisions = new Map<string, number>();
  const historical = (): boolean => !!current && current.revision.revision !== current.artifact.headRevision;

  function currentFile(snapshot = current): ArtifactFile | null {
    if (!snapshot) return null;
    return snapshot.revision.files.find(file => file.path === currentPath) ?? snapshot.revision.files[0] ?? null;
  }

  function destroyView(): void { editor?.destroy(); editor = null; diff?.destroy(); diff = null; preview?.destroy(); preview = null; content.replaceChildren(); }

  function artifactDrafts(artifactId = currentArtifactId, create = false): Map<string, Draft> | undefined {
    if (!artifactId) return undefined;
    let value = drafts.get(artifactId);
    if (!value && create) { value = new Map(); drafts.set(artifactId, value); }
    return value;
  }

  function draftFor(path = currentPath): Draft | undefined { return historical() ? undefined : artifactDrafts()?.get(path); }
  function hasDrafts(artifactId = currentArtifactId): boolean { return (artifactDrafts(artifactId)?.size ?? 0) > 0; }
  function hasConflict(): boolean {
    return !!current && [...(artifactDrafts()?.values() ?? [])].some(draft => draft.revision !== current!.artifact.headRevision);
  }
  function setDraft(path: string, text: string, canonical: string): void {
    if (!currentArtifactId || !current || historical()) return;
    const map = artifactDrafts(currentArtifactId, true)!;
    if (text === canonical) map.delete(path); else map.set(path, { revision: current.artifact.headRevision, text });
    if (!map.size) drafts.delete(currentArtifactId);
  }
  function workingFiles(): ArtifactFile[] {
    if (!current) return [];
    if (historical()) return current.revision.files;
    const map = artifactDrafts();
    return current.revision.files.map(file => {
      const draft = map?.get(file.path);
      return draft?.revision === current!.artifact.headRevision ? { ...file, text: draft.text, bytes: new TextEncoder().encode(draft.text).byteLength } : file;
    });
  }

  function retainDraft(): void {
    if (!current || !currentArtifactId || !currentPath || !editor || historical()) return;
    const canonical = currentFile()?.text;
    if (canonical !== undefined) setDraft(currentPath, editor.getValue(), canonical);
  }

  function hide(): void {
    retainDraft(); generation++; destroyView(); pane.hidden = true; status.hidden = true;
  }

  function updateChrome(): void {
    const summary = current ? summaryFrom(current) : currentArtifactId ? summaries.get(currentArtifactId) : null;
    title.textContent = summary?.title ?? t('Artifact');
    revision.textContent = current ? (historical() ? `r${current.revision.revision} · head r${current.artifact.headRevision}` : `r${current.artifact.headRevision}`) : '';
    fileLabel.replaceChildren(icon('i-file-text'), el('strong', '', currentPath ? baseName(currentPath) : t('Artifact')));
    conflict = historical() ? false : hasConflict(); editorDirty = historical() ? false : hasDrafts();
    dirtyLabel.hidden = !editorDirty && !conflict; dirtyLabel.classList.toggle('is-conflict', conflict);
    dirtyLabel.textContent = conflict ? t('Conflict') : editorDirty ? t('Unsaved') : '';
    reload.hidden = !conflict; save.disabled = historical() || !editorDirty || conflict;
    exportButton.disabled = !current?.artifact.projectId || editorDirty || conflict;
    exportButton.title = !current?.artifact.projectId ? t('Link this chat to a local project before exporting')
      : editorDirty ? t('Save the artifact revision before exporting it') : '';
    for (const [key, button] of modeButtons) {
      button.classList.toggle('is-active', mode === key); button.setAttribute('aria-pressed', String(mode === key));
      button.disabled = key === 'preview' && summary?.capabilities.preview !== true;
    }
  }

  function fillFileSelect(): void {
    fileSelect.replaceChildren();
    for (const file of current?.revision.files ?? []) {
      const option = document.createElement('option'); option.value = file.path; option.textContent = file.path; option.selected = file.path === currentPath; fileSelect.append(option);
    }
    fileSelect.disabled = (current?.revision.files.length ?? 0) <= 1;
  }

  async function renderCode(token: number): Promise<void> {
    const file = currentFile(); if (!file || token !== generation) return;
    destroyView();
    const retained = draftFor(file.path);
    editorDraft = retained?.text ?? file.text;
    editorDirty = historical() ? false : hasDrafts(); conflict = historical() ? false : hasConflict();
    const nextEditor = await createProjectCodeEditor({ parent: content, filename: file.path, text: editorDraft, readOnly: historical() || file.bytes > 256 * 1024,
      onChange: value => { editorDraft = value; setDraft(file.path, value, file.text); updateChrome(); } });
    if (token !== generation) { nextEditor.destroy(); return; }
    editor = nextEditor;
    language.textContent = editor.language; updateChrome();
  }

  async function renderDiff(token: number): Promise<void> {
    const file = currentFile(); if (!file || token !== generation) return;
    retainDraft(); destroyView(); language.textContent = '';
    let base = ''; let next = file.text;
    const draft = draftFor(file.path);
    if (draft?.revision === current!.artifact.headRevision) { base = file.text; next = draft.text; }
    else if (current!.revision.parentRevision) {
      const prior = await run(window.api.readArtifact(current!.artifact.sessionId, current!.artifact.id, current!.revision.parentRevision));
      if (token !== generation) return;
      base = prior?.revision.files.find(entry => entry.path === file.path)?.text ?? '';
    }
    const nextDiff = await createProjectDiffViewer({ parent: content, filename: file.path, baseText: base, currentText: next });
    if (token !== generation) { nextDiff.destroy(); return; }
    diff = nextDiff;
    language.textContent = diff.language; editorDirty = historical() ? false : hasDrafts(); conflict = historical() ? false : hasConflict(); updateChrome();
  }

  async function renderPreview(token: number): Promise<void> {
    retainDraft(); destroyView(); language.textContent = '';
    if (token !== generation || !current) return;
    const previewSession = current.artifact.sessionId, previewArtifact = current.artifact.id, previewRevision = current.revision.revision;
    const messages = el('div', 'artifact-preview-console');
    preview = createArtifactPreview({ parent: content, controls: actions, files: workingFiles(), entrypoint: current.artifact.entrypoint, kind: current.artifact.kind,
      createDocument: document => run(window.api.createArtifactPreviewDocument(previewSession, previewArtifact, previewRevision, document)),
      releaseDocument: id => { void window.api.releaseArtifactPreviewDocument(previewSession, id); },
      onMessage: message => {
        const row = el('div', `artifact-preview-message is-${message.level}`, `${message.level}: ${message.text}`); messages.append(row);
        while (messages.childElementCount > 20) messages.firstElementChild?.remove();
      } });
    content.append(messages); status.hidden = true;
    updateChrome();
  }

  async function setMode(next: Mode): Promise<void> {
    if (mode === next && (editor || diff || !status.hidden)) return;
    mode = next; status.hidden = true; const token = ++generation; updateChrome();
    if (next === 'code') await renderCode(token); else if (next === 'diff') await renderDiff(token); else await renderPreview(token);
  }

  async function load(artifactId: string, requestedRevision = openedRevisions.get(artifactId)): Promise<void> {
    if (!sessionId) return;
    const token = ++generation; status.hidden = false; status.textContent = t('Loading…'); destroyView();
    const snapshot = await run(window.api.readArtifact(sessionId, artifactId, requestedRevision));
    if (token !== generation || artifactId !== currentArtifactId || !snapshot) return;
    current = snapshot; summaries.set(artifactId, summaryFrom(snapshot));
    const retained = drafts.get(artifactId);
    const retainedPath = retained ? [...retained.keys()].find(path => snapshot.revision.files.some(file => file.path === path)) : undefined;
    currentPath = retainedPath ?? snapshot.artifact.entrypoint ?? snapshot.revision.files[0]?.path ?? '';
    fillFileSelect(); status.hidden = true; updateChrome();
    await setMode(mode);
  }

  function register(summary: ArtifactSummary): void {
    const id = surfaceId(summary.id);
    const providerNative = typeof summary.origin.providerArtifactId === 'string' && summary.origin.providerArtifactId.length > 0;
    options.docks.registerSurface({ id, kind: 'artifact', title: summary.title, icon: artifactIcon(summary), sessionId: summary.sessionId,
      projectId: summary.projectId, closable: true, dirty: hasDrafts(summary.id) }, mount => {
      if (pane.parentElement !== mount) mount.append(pane);
      pane.hidden = false; currentArtifactId = summary.id; current = null; currentPath = ''; mode = summary.capabilities.preview ? 'preview' : 'code';
      void load(summary.id, openedRevisions.get(summary.id));
    }, () => { if (currentArtifactId === summary.id) hide(); }, () => sessionId === summary.sessionId, undefined, { launcher: providerNative });
    registered.add(id);
  }

  async function sync(nextSessionId: string | null): Promise<void> {
    if (sessionId === nextSessionId && (nextSessionId === null || registered.size > 0)) return;
    retainDraft(); hide(); const token = ++generation;
    for (const id of registered) options.docks.unregisterSurface(id);
    registered = new Set(); summaries = new Map(); sessionId = nextSessionId; currentArtifactId = null; current = null;
    if (!nextSessionId) return;
    const list = await run(window.api.listArtifacts(nextSessionId));
    if (token !== generation || sessionId !== nextSessionId || !list) return;
    for (const summary of list) { summaries.set(summary.id, summary); register(summary); }
  }

  async function open(request: ArtifactOpenRequest): Promise<void> {
    if (options.selectedSession() !== request.sessionId) options.selectSession(request.sessionId);
    if (sessionId !== request.sessionId) await sync(request.sessionId);
    let summary = summaries.get(request.artifactId);
    if (!summary) {
      const snapshot = await run(window.api.readArtifact(request.sessionId, request.artifactId, request.revision));
      if (!snapshot || sessionId !== request.sessionId) return;
      summary = summaryFrom(snapshot); summaries.set(summary.id, summary); register(summary);
    }
    if (request.revision !== undefined) openedRevisions.set(request.artifactId, request.revision);
    else openedRevisions.delete(request.artifactId);
    options.docks.activateSurface(surfaceId(request.artifactId));
  }

  fileSelect.addEventListener('change', () => { retainDraft(); currentPath = fileSelect.value; void setMode(mode); });
  copy.addEventListener('click', () => void (async () => {
    const value = mode === 'code' ? editor?.getValue() ?? editorDraft : currentFile()?.text ?? '';
    if (await run(window.api.writeClipboard(value))) ui(copy, 'textContent', () => t('Copied'));
    else toast(t('Could not copy text.'));
  })());
  save.addEventListener('click', () => void (async () => {
    retainDraft();
    if (!current || !currentArtifactId || !hasDrafts() || hasConflict()) return;
    const changed = artifactDrafts()!;
    const byPath = new Map(current.revision.files.map(file => [file.path, file]));
    const operations = [...changed].map(([path, draft]) => {
      const file = byPath.get(path);
      return { op: 'upsert' as const, path, text: draft.text, ...(file?.mimeType ? { mimeType: file.mimeType } : {}),
        ...(file?.language ? { language: file.language } : {}) };
    });
    const ownerSessionId = current.artifact.sessionId, artifactId = currentArtifactId, expectedRevision = current.artifact.headRevision;
    save.disabled = true;
    const reply = await window.api.patchArtifact(ownerSessionId, artifactId, expectedRevision, {
      operations
    });
    if (sessionId !== ownerSessionId || currentArtifactId !== artifactId || current?.artifact.sessionId !== ownerSessionId ||
        current.artifact.id !== artifactId || current.artifact.headRevision !== expectedRevision) return;
    if (!reply.ok) { conflict = true; reload.hidden = false; updateChrome(); toast(reply.error); return; }
    current = reply.data; summaries.set(artifactId, summaryFrom(reply.data)); drafts.delete(artifactId); editorDirty = false; conflict = false;
    fillFileSelect(); updateChrome(); toast(t('Saved')); void setMode(mode);
  })());
  exportButton.addEventListener('click', () => void (async () => {
    if (!current || !currentArtifactId || !current.artifact.projectId || hasDrafts() || hasConflict()) return;
    exportButton.disabled = true;
    const reply = await window.api.exportArtifact(current.artifact.sessionId, currentArtifactId, current.revision.revision);
    if (!reply.ok) toast(reply.error); else toast(t('Saved to project: {0}', [reply.data.directory]));
    updateChrome();
  })());
  reload.addEventListener('click', () => { if (!currentArtifactId) return; drafts.delete(currentArtifactId); conflict = false; void load(currentArtifactId); });
  pane.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save.click(); }
    else if (event.key === 'Escape') { event.preventDefault(); options.docks.setOpen(false); options.docks.rightToggle.focus(); }
  });
  // A model in a background chat cannot navigate away from the chat being read.
  // Its durable inline presentation remains available when that chat is selected.
  const stopOpen = window.api.onArtifactOpen(request => {
    if (options.selectedSession() === request.sessionId) void open(request);
  });
  window.addEventListener('beforeunload', stopOpen, { once: true });

  updateChrome();
  return { sync, open, hide, surfaceId };
}
