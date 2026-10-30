import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Config } from '../shared/types.js';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const version = (value: unknown): number[] | null => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : null;
function compare(a: number[], b: number[]): number { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!; return 0; }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Restore preferences still at recovery defaults; keep later nondefault edits. */
function preferences(prior: unknown, current: unknown, defaults: unknown): unknown {
  if (current === undefined || same(current, defaults)) return prior;
  if (!object(prior) || !object(current) || !object(defaults)) return current;
  return Object.fromEntries([...new Set([...Object.keys(prior), ...Object.keys(current)])]
    .map(key => [key, preferences(prior[key], current[key], defaults[key])]));
}

/** Uses the existing config backup and native reset/version log, never a guessed
 * profile, connector, permission or credential. Unrelated corrupt backups fail closed. */
export async function recoverDowngradedSetup(file: string, current: Config, defaults: Config,
  validate: (value: unknown) => Config | null, currentVersion: string): Promise<{ config: Config; backup: string } | null> {
  const directory = path.dirname(file), running = version(currentVersion);
  const normalizedDefaults = validate(defaults);
  if (!running || !normalizedDefaults) return null;
  defaults = normalizedDefaults;
  const logs: string[] = [];
  for (const name of ['app.log.1', 'app.log']) {
    try {
      const log = path.join(directory, name), stat = await fs.lstat(log);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 5 * 1024 * 1024) logs.push(...(await fs.readFile(log, 'utf8')).split(/\r?\n/));
    } catch { /* No native reset evidence means no automatic restoration. */ }
  }
  const names = (await fs.readdir(directory)).filter(name => /^config\.json\.unreadable-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/.test(name)).sort().reverse().slice(0, 32);
  for (const name of names) {
    const match = /unreadable-(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/.exec(name)!;
    const at = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
    const near = logs.filter(line => { const time = Date.parse(line.slice(0, 24)); return time >= at - 2000 && time <= at + 10_000; });
    if (!near.some(line => line.includes(`its original was kept as ${name}`)) ||
        !near.some(line => line.includes('Settings file was invalid and has been reset to defaults'))) continue;
    const reverted = near.map(line => version(/\sinfo\s+app version (\d+\.\d+\.\d+)$/.exec(line)?.[1])).find(value => value !== null);
    if (!reverted) continue;
    try {
      const backup = path.join(directory, name), stat = await fs.lstat(backup);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) continue;
      const bytes = await fs.readFile(backup), digest = createHash('sha256').update(bytes).digest('hex');
      if (current.ui.setupRecoveryBackup === digest) return null;
      const prior = validate(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))), written = version(prior?.ui.lastSeenVersion);
      if (!prior || !written || compare(written, reverted) <= 0 || compare(written, running) > 0) continue;
      // A pristine recovery state may recover its original grants. Once a user
      // changed access, preserve that current access rather than regranting it.
      const security = ['roots', 'capabilities', 'readOnly', 'commandAllowlist', 'multiAgent', 'goal', 'controlApi', 'agentApi'] as const;
      const untouched = security.every(key => same(current[key], defaults[key]));
      const connectionUnchanged = same(current.tunnel, defaults.tunnel) || same(current.tunnel, prior.tunnel);
      const restored: Config = untouched && connectionUnchanged ? structuredClone(prior) : {
        ...current,
        ui: preferences(prior.ui, current.ui, defaults.ui) as Config['ui'],
        mcp: preferences(prior.mcp, current.mcp, defaults.mcp) as Config['mcp'],
        connectorSuffix: current.connectorSuffix ?? prior.connectorSuffix
      };
      restored.ui.setupRecoveryBackup = digest;
      const checked = validate(restored);
      if (checked) return { config: checked, backup: name };
    } catch { /* Never replace settings from malformed or inaccessible evidence. */ }
  }
  return null;
}
