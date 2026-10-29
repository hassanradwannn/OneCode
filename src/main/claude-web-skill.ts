import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import { zipSync } from 'fflate';
import { CLAUDE_WEB_SKILL_NAME, CLAUDE_WEB_SKILL_VERSION, type ClaudeSkillExportFormat, type ClaudeSkillExportResult } from '../shared/claude-web-skill.js';
import { packagedApplicationResources } from './application-resources.js';

/** Only the public bundled asset is exportable; no caller-provided file or credentials. */
export async function readBundledClaudeSkill(): Promise<Buffer> {
  const root = app.isPackaged ? packagedApplicationResources() : path.join(app.getAppPath(), 'resources');
  let bytes: Buffer;
  // The internal adapter asset path is stable; only the native uploaded name/ZIP root is public.
  try { bytes = await fs.readFile(path.join(root, 'skills', 'onecode-claude', 'SKILL.md')); }
  catch { throw new Error('The bundled provider skill could not be read. Reinstall OneCode.'); }
  if (bytes.length > 64 * 1024) throw new Error('The bundled provider skill is invalid. Reinstall OneCode.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('The bundled provider skill is invalid. Reinstall OneCode.'); }
  if (!/^---\r?\nname: onecode\r?\ndescription: [^\r\n]+\r?\n---\r?\n/.test(text) || text.includes('\0') || !text.includes(CLAUDE_WEB_SKILL_VERSION))
    throw new Error('The bundled provider skill is invalid. Reinstall OneCode.');
  return bytes;
}

export async function exportBundledClaudeSkill(format: ClaudeSkillExportFormat, owner: BrowserWindow | null): Promise<ClaudeSkillExportResult> {
  if (format !== 'markdown' && format !== 'zip') throw new Error('Unknown skill export format');
  const bytes = await readBundledClaudeSkill();
  const options = { title: 'Save provider skill',
    defaultPath: path.join(app.getPath('downloads'), format === 'zip' ? 'OneCode-Skill.zip' : 'SKILL.md'),
    filters: [{ name: format === 'zip' ? 'Skill ZIP' : 'SKILL.md', extensions: [format === 'zip' ? 'zip' : 'md'] }] };
  const selected = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (selected.canceled || !selected.filePath) return { done: 'cancelled' };
  await fs.writeFile(selected.filePath, format === 'zip' ? zipSync({ [`${CLAUDE_WEB_SKILL_NAME}/SKILL.md`]: bytes }) : bytes);
  return { done: 'saved', name: path.basename(selected.filePath) };
}
