import { marked } from 'marked';
import { safeExternalLink } from '../shared/external-link.js';
import type { ToolEditReview } from '../shared/session.js';
import type { RecordedChangeRef, TurnFileChange } from '../shared/turn-changes.js';
import { workspaceLinksInMarkdown, type WorkspaceDocument } from '../shared/workspace-link.js';
import { el, icon } from './dom.js';
import { MESSAGE_DROP_TAGS, MESSAGE_TAGS } from './message-format.js';
import { sanitizeHtmlTree } from './sanitize-html.js';

export type DeliverableLabel = (message: string, args?: Array<string | number>) => string;
type Actions = {
  label: DeliverableLabel;
  copy: (value: string) => Promise<boolean>;
  openExternal: (href: string) => void;
};

function button(label: string, fn: () => void, glyph?: string): HTMLButtonElement {
  const node = el('button', 'deliverable-action') as HTMLButtonElement;
  node.type = 'button';
  if (glyph) { node.append(icon(glyph)); node.setAttribute('aria-label', label); node.title = label; }
  else node.textContent = label;
  node.addEventListener('click', fn);
  return node;
}

/** Native providers can drop custom hrefs while retaining the label and other native content. */
export function restoreWorkspaceLinks(root: ParentNode, source: string): void {
  for (const [href, label] of workspaceLinksInMarkdown(source)) {
    const anchors = [...root.querySelectorAll('a')].filter(anchor => !anchor.closest('pre, code'));
    if (anchors.some(anchor => anchor.getAttribute('href') === href)) continue;
    const match = anchors.filter(anchor => !anchor.hasAttribute('href') && anchor.textContent?.trim() === label);
    const anchor = match.length === 1 ? match[0]! : document.createElement('a');
    anchor.setAttribute('href', href);
    if (!anchor.parentNode) {
      anchor.textContent = label;
      const line = document.createElement('p');
      line.append(anchor);
      root.appendChild(line);
    }
  }
}

export function renderWorkspaceDocument(file: WorkspaceDocument, actions: Actions): HTMLElement {
  const { label } = actions;
  const pane = el('section', 'deliverable-pane');
  const header = el('header', 'deliverable-header');
  const name = el('strong', '', file.name);
  name.title = file.path;
  const copyLabel = label(/\.(md|markdown)$/i.test(file.name) ? 'Copy Markdown' : 'Copy file contents');
  const status = el('span', 'deliverable-status', '');
  status.setAttribute('role', 'status');
  const copy = button(copyLabel, () => {
    void actions.copy(file.text).then(ok => { status.textContent = label(ok ? 'Copied' : 'Could not copy text.'); });
  }, 'i-copy');
  copy.disabled = file.truncated;
  header.append(name, status, copy);
  const content = el('div', 'deliverable-document file-preview-markdown');
  if (/\.(md|markdown)$/i.test(file.name)) {
    const template = document.createElement('template');
    template.innerHTML = marked.parse(file.text, { async: false, gfm: true });
    sanitizeHtmlTree(template.content, { allowedTags: MESSAGE_TAGS, dropTags: MESSAGE_DROP_TAGS,
      safeHref: value => safeExternalLink(value) ? value : null });
    content.append(template.content);
    content.addEventListener('click', event => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!anchor || !content.contains(anchor)) return;
      event.preventDefault();
      const href = anchor.getAttribute('href') ?? '';
      if (safeExternalLink(href)) actions.openExternal(href);
    });
  } else content.append(el('pre', 'deliverable-source', file.text));
  if (file.truncated) content.prepend(el('p', 'meta', label('Preview truncated.')));
  pane.append(header, content);
  return pane;
}

function delta(path: TurnFileChange): HTMLElement {
  const result = el('span', 'deliverable-delta');
  result.append(el('span', 'metric-added', `${path.approximate ? '~' : ''}+${path.added}`), el('span', 'metric-removed', `−${path.removed}`));
  return result;
}

function fileRows(files: readonly TurnFileChange[], activate: (index: number) => void): HTMLElement {
  const list = el('ul', 'deliverable-file-list');
  for (const [index, file] of files.entries()) {
    const row = el('li', 'deliverable-file-row');
    const available = file.edits.some(edit => edit.reviewable);
    const choice = available ? button(file.path, () => activate(index)) : el('span', 'deliverable-action', file.path);
    choice.classList.add('deliverable-file-path');
    choice.title = file.path;
    row.append(choice, delta(file));
    list.append(row);
  }
  return list;
}

export function renderTurnChangeSummary(files: readonly TurnFileChange[], label: DeliverableLabel, show: (index?: number) => void): HTMLElement {
  const card = el('section', 'turn-file-report');
  const header = el('header', 'turn-file-report-header');
  const title = el('strong', '', label(files.length === 1 ? '1 changed file' : '{0} changed files', [files.length]));
  const total: TurnFileChange = { path: '', added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0), approximate: files.some(file => file.approximate), edits: [] };
  header.append(icon('i-git-diff'), title, delta(total), button(label('View changes'), () => show()));
  card.append(header, fileRows(files, show));
  return card;
}

export function renderTurnReview(files: readonly TurnFileChange[], initial: number | undefined, label: DeliverableLabel,
  load: (change: RecordedChangeRef) => Promise<ToolEditReview | null>, current: () => boolean): HTMLElement {
  const pane = el('section', 'deliverable-pane deliverable-review');
  const content = el('div', 'deliverable-review-content');
  const revisions = el('select', 'deliverable-revisions') as HTMLSelectElement;
  revisions.setAttribute('aria-label', label('Recorded edit'));
  const viewport = el('div', 'unified-diff deliverable-review-diff');
  viewport.tabIndex = 0;
  const name = el('strong', '', '');
  const header = el('header', 'deliverable-header');
  header.append(name, revisions);
  content.append(header, viewport);
  let selected = -1, generation = 0;
  const show = async (choice: number): Promise<void> => {
    const file = files[selected];
    const edit = file?.edits[choice];
    const version = ++generation;
    const alive = () => current() && generation === version;
    if (!file || !edit?.reviewable) {
      viewport.replaceChildren(el('p', 'meta', label('Recorded diff unavailable.')));
      return;
    }
    viewport.replaceChildren(el('p', 'meta', label('Loading edit…')));
    const snapshot = await load(edit).catch(() => null);
    if (!alive()) return;
    if (!snapshot || snapshot.callId !== edit.callId || snapshot.changeIndex !== edit.changeIndex) {
      viewport.replaceChildren(el('p', 'meta', label('Recorded diff unavailable.')));
      return;
    }
    const { renderUnifiedDiff } = await import('./unified-diff.js');
    if (alive()) await renderUnifiedDiff(viewport, snapshot.path, snapshot.baseText, snapshot.currentText, alive);
  };
  const select = (index: number): void => {
    const file = files[index];
    if (!file) return;
    selected = index;
    name.textContent = file.path; name.title = file.path;
    viewport.setAttribute('aria-label', label('Diff for {0}', [file.path]));
    revisions.replaceChildren(...file.edits.map((edit, index) => {
      const option = document.createElement('option'); option.value = String(index);
      option.textContent = label('Edit {0} of {1}', [index + 1, file.edits.length]); option.disabled = !edit.reviewable;
      return option;
    }));
    revisions.hidden = file.edits.length <= 1;
    const choice = file.edits.findLastIndex(edit => edit.reviewable);
    revisions.value = String(choice);
    for (const [at, row] of [...list.children].entries()) row.querySelector('button')?.setAttribute('aria-current', String(at === selected));
    void show(choice);
  };
  revisions.onchange = () => { void show(Number(revisions.value)); };
  const list = fileRows(files, select);
  pane.append(list, content);
  const first = initial ?? files.findIndex(file => file.edits.some(edit => edit.reviewable));
  if (first >= 0) select(first);
  else { content.hidden = true; }
  return pane;
}
