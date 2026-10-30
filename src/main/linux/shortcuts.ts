import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BUILD_CHANNEL } from '../../shared/build-channel.js';

const canonical = BUILD_CHANNEL === 'beta' ? 'io.onecode.desktop.beta.desktop' : 'io.onecode.desktop';
const legacy = BUILD_CHANNEL === 'beta' ? canonical : 'io.onecode.desktop.desktop';
const wmClass = canonical.replace(/\.desktop$/, '');
function executable(text: string): string | null {
  const section = text.split(/^\[/m).find(part => part.startsWith('Desktop Entry]'));
  const line = section?.split(/\r?\n/).find(row => row.startsWith('Exec='));
  const match = line && /^Exec=(?:"((?:\\.|[^"\\])*)"|(\S+))(?:\s|$)/.exec(line);
  const value = match && (match[1] ?? match[2])?.replace(/\\(["\\$`])/g, '$1').replaceAll('%%', '%');
  return value && path.isAbsolute(value) ? value : null;
}
function grouped(text: string): string {
  const lines = text.split(/\r?\n/), start = lines.indexOf('[Desktop Entry]');
  if (start < 0) return text;
  let end = lines.findIndex((line, index) => index > start && line.startsWith('['));
  if (end < 0) end = lines.length;
  const field = lines.findIndex((line, index) => index > start && index < end && line.startsWith('StartupWMClass='));
  if (field >= 0) lines[field] = `StartupWMClass=${wmClass}`; else lines.splice(start + 1, 0, `StartupWMClass=${wmClass}`);
  return lines.join('\n');
}

/** Repair only this installation's existing user launchers. Never change another
 * executable, profile argument, connector or unrelated favourite. */
export async function repairLinuxShortcuts(target: string, options: { home?: string; run?: (args: string[]) => Promise<string> } = {}): Promise<void> {
  const directory = path.join(options.home ?? os.homedir(), '.local/share/applications');
  let actual: string;
  try { const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) return; actual = await fs.realpath(target); }
  catch { return; }
  const owned = new Map<string, string>();
  for (const name of new Set([canonical, legacy])) {
    try {
      const file = path.join(directory, name), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) continue;
      const text = await fs.readFile(file, 'utf8'), command = executable(text);
      if (command && await fs.realpath(command) === actual) owned.set(name, text);
    } catch { /* Unowned or inaccessible launchers remain untouched. */ }
  }
  if (!owned.size) return;
  if (!owned.has(canonical)) {
    // A canonical launcher that already exists but is foreign must not be replaced.
    try { await fs.lstat(path.join(directory, canonical)); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await fs.writeFile(path.join(directory, canonical), grouped(owned.get(legacy)!), { flag: 'wx', mode: 0o644 });
    owned.set(canonical, grouped(owned.get(legacy)!));
  }
  for (const [name, text] of owned) {
    const next = grouped(text); if (text === next) continue;
    const file = path.join(directory, name);
    try { await fs.copyFile(file, `${file}.before-0.8.2`, constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await fs.writeFile(`${file}.tmp`, next, { mode: 0o644 }); await fs.rename(`${file}.tmp`, file);
  }
  if (legacy === canonical || !owned.has(legacy)) return;
  const run = options.run ?? (async args => (await promisify(execFile)('/usr/bin/gsettings', args, { timeout: 2000, maxBuffer: 64 * 1024 })).stdout);
  const raw = (await run(['get', 'org.gnome.shell', 'favorite-apps'])).trim();
  if (!/^\[(?:\s*'[A-Za-z0-9_.+-]+'\s*,?)*\s*\]$/.test(raw)) return;
  const names = [...raw.matchAll(/'([^']+)'/g)].map(match => match[1]!);
  if (!names.includes(legacy)) return;
  const next = names.includes(canonical) ? names.filter(name => name !== legacy) : names.map(name => name === legacy ? canonical : name);
  await run(['set', 'org.gnome.shell', 'favorite-apps', JSON.stringify(next)]);
}
