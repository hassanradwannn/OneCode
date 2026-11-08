import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Root } from '../../shared/types.js';
import { localWorkbenchUrl } from '../../shared/workbench-browser.js';
import { createArtifact, type CreateArtifactInput } from '../artifacts/service.js';
import { browserControl } from '../browser-control.js';
import { runningExecProcesses } from '../codex/ownership.js';
import type { ExecCommandToolOutput } from '../codex/unified-exec.js';
import { effectiveCapabilities, getConfig } from '../config.js';
import { resolvePath } from '../sandbox.js';
import { readEvents } from '../session/store.js';
import type { OwnedTurn } from './tools.js';
import { currentApiTurn } from './tools.js';

const MAX_FILES = 128, MAX_FILE = 2 * 1024 * 1024, MAX_BUNDLE = 8 * 1024 * 1024;
const tailLength = 24_000;
type Evidence = { workdir: string; output: string };

/** A web preview is sourced from the exact turn's local command receipts. */
export type ApiWebObserver = (id: number, output: ExecCommandToolOutput, workdir?: string) => void;

async function readBuild(roots: readonly Root[], directory: string, since: number): Promise<CreateArtifactInput['files']> {
  const root = await resolvePath(roots, directory);
  const entry = await resolvePath(roots, `${directory}/index.html`);
  const entryStat = await fs.stat(entry.real);
  if (!entryStat.isFile() || entryStat.mtimeMs < since - 2_000) return [];
  const files: CreateArtifactInput['files'] = [];
  let bytes = 0, scanned = 0;
  const walk = async (folder: string, depth: number): Promise<void> => {
    if (depth > 8) throw new Error('Build output nesting exceeds the preview limit');
    const current = await resolvePath(roots, folder ? `${directory}/${folder}` : directory);
    const listing = await fs.opendir(current.real);
    for await (const item of listing) {
      if (++scanned > MAX_FILES * 2) throw new Error('Build output exceeds the preview file limit');
      const relative = folder ? `${folder}/${item.name}` : item.name;
      if (item.isDirectory()) { await walk(relative, depth + 1); continue; }
      if (item.isFile() && /\.(?:map|license\.txt)$/i.test(item.name)) continue;
      if (!item.isFile() || !/\.(?:html?|[cm]?js|css|svg|json|txt)$/i.test(item.name) || files.length >= MAX_FILES)
        throw new Error('Build includes files that cannot be imported into the offline preview');
      const file = await resolvePath(roots, `${directory}/${relative}`);
      if (path.relative(root.real, file.real) !== relative.split('/').join(path.sep))
        throw new Error('Build file moved outside its original directory');
      const handle = await fs.open(file.real, 'r');
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > MAX_FILE || bytes + before.size > MAX_BUNDLE)
          throw new Error('Build exceeds the artifact size limit');
        const data = Buffer.alloc(before.size);
        for (let offset = 0; offset < data.length;) {
          const read = await handle.read(data, offset, data.length - offset, offset);
          if (!read.bytesRead) throw new Error('Build file changed during import');
          offset += read.bytesRead;
        }
        const checked = await resolvePath(roots, `${directory}/${relative}`);
        const after = await fs.stat(checked.real);
        if (checked.real !== file.real || before.dev !== after.dev || before.ino !== after.ino ||
            before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
          throw new Error('Build file changed during import');
        files.push({ path: relative, text: new TextDecoder('utf-8', { fatal: true }).decode(data) });
        bytes += data.length;
      } finally { await handle.close(); }
    }
  };
  await walk('', 0);
  return files;
}

export function apiWebPreview() {
  const processes = new Map<number, Evidence>();
  const servers = new Map<number, string>();
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
      const match = /^\s*(?:➜\s*)?Local:\s+(http:\/\/\S+)/im.exec(text);
      const url = /\bVITE\s+v[\d.]+\s+ready\b/i.test(text) && match?.[1] ? localWorkbenchUrl(match[1]) : null;
      if (url) servers.set(id, url);
      return;
    }
    processes.delete(id);
    servers.delete(id);
    if (output.exitCode !== 0 || !/\bvite\s+v[\d.]+[^\r\n]*\bbuilding\b/i.test(text)) return;
    const folder = /^\s*([a-zA-Z0-9_-]+)\/index\.html(?:\s|$)/m.exec(text)?.[1];
    if (folder) build = `${cwd.replace(/\/$/, '')}/${folder}`;
  };

  async function present(turn: OwnedTurn, since: number): Promise<void> {
    const mayOpen = async () => await currentApiTurn(turn) && effectiveCapabilities(getConfig()).control;
    for (const [id, url] of [...servers].reverse()) {
      if (!runningExecProcesses(turn.sessionId).some(row => row.processId === id)) continue;
      if (await browserControl.presentLocal(turn.sessionId, url, mayOpen).catch(() => false)) break;
    }
    if (!build) return;
    const config = getConfig(), caps = effectiveCapabilities(config);
    if (!caps.read || !caps.create || !await currentApiTurn(turn)) return;
    const existing = (await readEvents(turn.sessionId, { kinds: ['progress'] })).filter(event =>
      event.kind === 'progress' && event.turnId === turn.turnId && event.presentation?.kind === 'web');
    if (existing.some(event => event.kind === 'progress' && event.presentation?.status === 'ready')) return;
    const approved = await resolvePath(config.roots, build);
    const files = await readBuild(config.roots, build, since);
    const entry = files.find(file => file.path === 'index.html');
    if (!entry || /<link\b[^>]*\brel\s*=\s*["']modulepreload\b/i.test(entry.text)) return;
    const live = getConfig(), current = effectiveCapabilities(live);
    if (!current.read || !current.create || (await resolvePath(live.roots, build)).real !== approved.real ||
        !await currentApiTurn(turn)) return;
    const title = /<title\b[^>]*>([^<]{1,180})<\/title>/i.exec(entry.text)?.[1]?.trim() || 'Built web preview';
    await createArtifact({ sessionId: turn.sessionId, title, kind: 'web', entrypoint: 'index.html',
      origin: { provider: turn.provider ?? 'openrouter', conversationId: turn.conversationId, turnId: turn.turnId },
      files, source: 'filesystem' });
  }
  return { observe, present };
}
