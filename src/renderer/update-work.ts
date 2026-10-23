import type { UpdateWorkProcess, UpdateWorkSnapshot } from '../shared/update-work.js';
import { el, toast } from './dom.js';
import { t, ui } from './i18n.js';
import './update-work.css';

let dialog: HTMLDialogElement | null = null;
let revision = 0;
let reading = false;
let again = false;
let timer: number | null = null;
const stopping = new Set<string>();
const rows = new Map<string, { host: HTMLElement; owner: HTMLElement; command: HTMLElement; detail: HTMLElement; stop: HTMLButtonElement }>();
const key = (row: UpdateWorkProcess) => `${row.processId}:${row.incarnation}`;
let list: HTMLElement, status: HTMLElement, other: HTMLElement, retained: HTMLElement, output: HTMLElement;
let retainedSignature = '';
let quarantineOffset = 0;

function paint(snapshot: UpdateWorkSnapshot): void {
  const present = new Set<string>();
  for (const row of snapshot.processes) {
    const id = key(row); present.add(id);
    let view = rows.get(id);
    if (!view) {
      const host = el('li', 'update-work-process');
      const body = el('div', 'update-work-process-body');
      const owner = el('b'), command = el('code'), detail = el('small');
      const stop = el('button', 'btn btn-quiet') as HTMLButtonElement;
      stop.type = 'button';
      stop.onclick = () => void stopProcess(row);
      body.append(owner, command, detail); host.append(body, stop); list.append(host);
      rows.set(id, view = { host, owner, command, detail, stop });
    }
    view.owner.textContent = row.owner;
    view.command.textContent = row.command;
    ui(view.detail, 'textContent', () => row.detachedWsl
      ? t('Session {0} · WSL descendants · {1}', [row.processId, row.terminationState === 'termination-unknown'
        ? t('Termination not verified') : row.terminationState === 'pending' ? t('Checking owned processes') : t('Owned processes tracked')])
      : t('Session {0} · PID {1} · running for {2} min', [row.processId, row.pid,
        Math.max(0, Math.floor((Date.now() - row.startedAt) / 60_000))]));
    ui(view.stop, 'textContent', () => stopping.has(id) ? t('Stopping…') : t('Stop'));
    ui(view.stop, 'aria-label', () => t('Stop background process') + ` #${row.processId}: ${row.command}`);
    view.stop.disabled = stopping.has(id);
  }
  for (const [id, view] of rows) if (!present.has(id)) { view.host.remove(); rows.delete(id); stopping.delete(id); }
  ui(status, 'textContent', () => snapshot.inventory?.wslStorageError
    ? t('Background process status is unavailable. Some owned WSL processes may still be running.')
    : snapshot.processes.length ? t('{0} background processes tracked', [snapshot.processes.length])
      : t('No background processes are running.'));
  const messages: string[] = [];
  if (snapshot.browserActions.length) messages.push(t('{0} pending browser actions', [snapshot.browserActions.length]) + ': ' +
    snapshot.browserActions.map(row => row.kind + (row.error ? ` (${row.error})` : '')).join(', '));
  if (snapshot.terminalTabs) messages.push(t('{0} open terminal tabs, including hidden panels. Use Show open terminals to close them.', [snapshot.terminalTabs]));
  other.textContent = messages.join('\n');
  other.hidden = !messages.length;
  if (snapshot.inventory?.spoolError) {
    other.hidden = false; other.textContent += '\n' + snapshot.inventory.spoolError;
  }
  if (snapshot.inventory?.wslStorageError) {
    other.hidden = false; other.textContent += '\n' + snapshot.inventory.wslStorageError;
  }
  const quarantined = snapshot.quarantined ?? [];
  const signature = JSON.stringify([quarantined, snapshot.quarantinedTotal, snapshot.quarantineOffset]);
  if (signature !== retainedSignature) {
    retainedSignature = signature; retained.replaceChildren();
    if (quarantined.length || snapshot.quarantinedTotal) {
      const heading = el('h3'); ui(heading, 'textContent', () => t('Retained output awaiting chat attribution'));
      const lead = el('p'); ui(lead, 'textContent', () => t('These completed commands no longer occupy live process slots. Their output stays isolated until its chat ownership is proved or you discard it.'));
      retained.append(heading, lead);
      for (const row of quarantined) {
        const host = el('div', 'update-work-retained');
        const description = el('code'); description.textContent = `#${row.processId} · ${row.retainedBytes} bytes · exit ${row.exitCode ?? '?'}\n${row.command}`;
        host.append(description);
        if (row.outputInterrupted) {
          const warning = el('p'); ui(warning, 'textContent', () => row.outputCaptureIncomplete
            ? t('Interrupted by an app restart. Only the last output checkpoint is retained; the final result is unknown. The command was not run again.')
            : t('Output capture was interrupted. The retained bytes may be incomplete.'));
          host.append(warning);
        }
        for (const action of ['view', 'export', 'discard'] as const) {
          const button = el('button', 'btn btn-quiet') as HTMLButtonElement; button.type = 'button';
          ui(button, 'textContent', () => action === 'view' ? t('View output') : action === 'export' ? t('Export') : t('Discard output'));
          button.onclick = async () => {
            const captured = revision;
            button.disabled = true;
            try {
              if (action === 'view') {
                const reply = await window.api.inspectTerminalOutput(row.processId, row.incarnation);
                if (!reply.ok) throw new Error(reply.error);
                if (reply.data && dialog?.open && captured === revision) {
                  output.hidden = false; output.textContent = `#${row.processId} · ${row.command}\n\n` + reply.data.text + (reply.data.previewBytes < reply.data.retainedBytes
                    ? `\n[Preview: ${reply.data.previewBytes} of ${reply.data.retainedBytes} retained bytes. Export to keep all retained output.]` : '');
                }
              } else {
                const reply = await (action === 'export' ? window.api.exportTerminalOutput : window.api.discardTerminalOutput)(row.processId, row.incarnation);
                if (!reply.ok) throw new Error(reply.error);
                if (action === 'discard' && reply.data) { output.hidden = true; output.textContent = ''; }
              }
            } catch (error) { toast(error instanceof Error ? error.message : String(error)); }
            finally { button.disabled = false; revision++; void refresh(); }
          };
          host.append(button);
        }
        retained.append(host);
      }
      if ((snapshot.quarantinedTotal ?? 0) > 50 || quarantineOffset) {
        const pages = el('div');
        for (const direction of [-1, 1] as const) {
          const button = el('button', 'btn btn-quiet') as HTMLButtonElement; button.type = 'button';
          ui(button, 'textContent', () => direction < 0 ? t('Previous') : t('Next'));
          button.disabled = direction < 0 ? quarantineOffset === 0 : quarantineOffset + 50 >= (snapshot.quarantinedTotal ?? 0);
          button.onclick = () => { quarantineOffset = Math.max(0, quarantineOffset + direction * 50); output.hidden = true; output.textContent = ''; revision++; void refresh(); };
          pages.append(button);
        }
        retained.append(pages);
      }
    }
  }
}

async function refresh(): Promise<void> {
  if (!dialog?.open) return;
  if (reading) { again = true; return; }
  reading = true; const captured = revision;
  try {
    const reply = await window.api.updateWork(quarantineOffset);
    if (!dialog?.open || captured !== revision) return;
    if (!reply.ok) throw new Error(reply.error);
    paint(reply.data);
  } catch (error) {
    if (dialog?.open && captured === revision) status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    reading = false;
    if (again && dialog?.open) { again = false; void refresh(); }
  }
}

async function stopProcess(row: UpdateWorkProcess): Promise<void> {
  const id = key(row);
  if (stopping.has(id)) return;
  stopping.add(id); revision++;
  const view = rows.get(id);
  if (view) { view.stop.disabled = true; view.stop.textContent = t('Stopping…'); }
  try {
    const reply = await window.api.stopUpdateProcess(row.processId, row.incarnation);
    if (!reply.ok) throw new Error(reply.error);
    if (!reply.data) toast(t('Background process is no longer running'));
  } catch (error) { toast(error instanceof Error ? error.message : String(error)); }
  finally { stopping.delete(id); revision++; void refresh(); }
}

export function showUpdateWork(): void {
  if (!dialog) {
    dialog = document.createElement('dialog'); dialog.className = 'update-work-dialog';
    dialog.setAttribute('aria-labelledby', 'updateWorkTitle');
    const header = el('header'), title = el('h2'); title.id = 'updateWorkTitle';
    ui(title, 'textContent', () => t('Background work'));
    const close = el('button', 'btn btn-quiet') as HTMLButtonElement; close.type = 'button';
    ui(close, 'textContent', () => t('Close')); close.onclick = () => dialog?.close();
    header.append(title, close);
    const lead = el('p'); ui(lead, 'textContent', () => t('Commands can keep running after a chat is stopped. Stop an individual process here. Update now requests provider chats to stop, stops local commands, and restarts.'));
    status = el('p'); status.setAttribute('role', 'status');
    list = el('ul', 'update-work-list'); other = el('p', 'update-work-other');
    retained = el('section'); output = el('pre', 'update-work-output'); output.hidden = true;
    dialog.append(header, lead, status, list, other, retained, output);
    dialog.addEventListener('close', () => { revision++; if (timer !== null) window.clearInterval(timer); timer = null; });
    dialog.addEventListener('click', event => {
      if (!dialog || event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
    document.body.append(dialog);
  }
  if (!dialog.open) { revision++; quarantineOffset = 0; retainedSignature = ''; output.hidden = true; output.textContent = ''; dialog.showModal(); timer = window.setInterval(() => void refresh(), 2000); }
  void refresh();
}
