import { localWorkbenchUrl } from '../../shared/workbench-browser.js';
import { importWebBuild } from '../artifacts/import-web-build.js';
import { browserControl } from '../browser-control.js';
import { runningExecProcesses } from '../codex/ownership.js';
import type { ExecCommandToolOutput } from '../codex/unified-exec.js';
import { effectiveCapabilities, getConfig } from '../config.js';
import { readEvents } from '../session/store.js';
import type { OwnedTurn } from './tools.js';
import { currentApiTurn } from './tools.js';

const tailLength = 24_000;
type Evidence = { workdir: string; output: string };

/** A web preview is sourced from the exact turn's local command receipts. */
export type ApiWebObserver = (id: number, output: ExecCommandToolOutput, workdir?: string) => void;

export function apiWebPreview(sessionId: string) {
  const processes = new Map<number, Evidence>();
  const servers = new Map<number, { url: string; isRunning: () => boolean }>();
  let build: string | null = null;
  const observe: ApiWebObserver = (id, output, workdir) => {
    const previous = processes.get(id);
    const cwd = workdir ?? previous?.workdir;
    if (!cwd || output.replayed) return;
    const chunk = output.rawOutput.subarray(-tailLength).toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    const text = ((previous?.output ?? '') + chunk).slice(-tailLength);
    if (output.processId !== null) {
      if (processes.size >= 16 && !previous) return;
      processes.set(id, { workdir: cwd, output: text });
      const match = /^\s*(?:âžœ\s*)?Local:\s+(http:\/\/\S+)/im.exec(text);
      const url = /\bVITE\s+v[\d.]+\s+ready\b/i.test(text) && match?.[1] ? localWorkbenchUrl(match[1]) : null;
      if (url && servers.get(id)?.url !== url) {
        const process = runningExecProcesses(sessionId).find(row => row.processId === id);
        if (process) {
          const isRunning = () => runningExecProcesses(sessionId).some(row => row.processId === id && row.incarnation === process.incarnation);
          servers.set(id, { url, isRunning });
          browserControl.trackLocalPreview(sessionId, url, isRunning);
        }
      }
      return;
    }
    processes.delete(id);
    servers.delete(id);
    if (output.exitCode !== 0 || !/\bvite\s+v[\d.]+[^\r\n]*\bbuilding\b/i.test(text)) return;
    const folder = /^\s*([a-zA-Z0-9_-]+)\/index\.html(?:\s|$)/m.exec(text)?.[1];
    if (folder) build = `${cwd.replace(/\/$/, '')}/${folder}`;
  };

  async function present(turn: OwnedTurn, since: number): Promise<void> {
    for (const { url, isRunning } of [...servers.values()].reverse()) {
      if (!isRunning()) continue;
      const mayOpen = async () => await currentApiTurn(turn) && effectiveCapabilities(getConfig()).control && isRunning();
      if (await browserControl.presentLocal(turn.sessionId, url, mayOpen).catch(() => false)) break;
    }
    if (!build) return;
    const config = getConfig(), caps = effectiveCapabilities(config);
    if (!caps.read || !caps.create || !await currentApiTurn(turn)) return;
    const existing = (await readEvents(turn.sessionId, { kinds: ['progress'] })).filter(event =>
      event.kind === 'progress' && event.turnId === turn.turnId && event.presentation?.kind === 'web');
    if (existing.some(event => event.kind === 'progress' && event.presentation?.status === 'ready')) return;
    await importWebBuild({
      sessionId: turn.sessionId, path: build, roots: config.roots, since,
      origin: { provider: turn.provider ?? 'openrouter', conversationId: turn.conversationId, turnId: turn.turnId },
      current: () => currentApiTurn(turn)
    });
  }
  return { observe, present };
}
