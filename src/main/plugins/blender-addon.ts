import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// The companion bundled in blender_mcp-1.9.1-py3-none-any.whl, PyPI SHA-256
// ede3aed34926f77142b8f00ee4f8544f68067d2dc747da8295d1c456171355b2.
// Export the installed matching file; never fetch a moving upstream addon or execute it.
const ADDON_SHA256 = 'f43469c8518c7021e0060e32cfe52e3beb126b0f62fbae7293106642a3ebda89';
export async function blenderAddonFile(directory: string, version: string, platform = process.platform): Promise<Buffer> {
  if (version !== '1.9.1') throw new Error('Update Blender MCP to the catalog version before downloading its matching add-on.');
  const venv = await fs.realpath(path.join(directory, 'venv'));
  const sites = platform === 'win32' ? [path.join(venv, 'Lib', 'site-packages')]
    : (await fs.readdir(path.join(venv, 'lib'))).filter(name => /^python\d+\.\d+$/.test(name))
      .map(name => path.join(venv, 'lib', name, 'site-packages'));
  const files: string[] = [];
  for (const site of sites) {
    try { files.push(await fs.realpath(path.join(site, 'blender_mcp', 'bundled', 'addon.py'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (files.length !== 1 || !files[0]!.startsWith(venv + path.sep)) throw new Error('The installed Blender add-on could not be located. Update or reinstall Blender MCP.');
  const file = files[0]!;
  if ((await fs.stat(file)).size !== 175194) throw new Error('The installed Blender add-on failed verification. Update or reinstall Blender MCP.');
  const bytes = await fs.readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== ADDON_SHA256) throw new Error('The installed Blender add-on failed verification. Update or reinstall Blender MCP.');
  return bytes;
}
