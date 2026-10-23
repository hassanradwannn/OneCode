import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import { zipSync } from 'fflate';
import { CHATGPT_WEB_SKILL_NAME, CHATGPT_WEB_SKILL_VERSION, type ChatgptSkillExportFormat, type ChatgptSkillExportResult } from '../shared/chatgpt-web-skill.js';
import { packagedApplicationResources } from './application-resources.js';

/** The caller selects a format, never an arbitrary source file or credential. */
export async function readBundledChatgptSkill(): Promise<Buffer> {
  const root = app.isPackaged ? packagedApplicationResources() : app.getAppPath();
  const bytes = await fs.readFile(path.join(root, 'skills', CHATGPT_WEB_SKILL_NAME, 'SKILL.md'));
  if (bytes.length > 64 * 1024) throw new Error('The bundled ChatGPT skill is invalid. Reinstall OneCode.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!/^---\r?\nname: onecode-chatgpt\r?\ndescription: [^\r\n]+\r?\n---\r?\n/.test(text) || text.includes('\0') || !text.includes(CHATGPT_WEB_SKILL_VERSION))
    throw new Error('The bundled ChatGPT skill is invalid. Reinstall OneCode.');
  return bytes;
}

export async function exportBundledChatgptSkill(format: ChatgptSkillExportFormat, owner: BrowserWindow | null): Promise<ChatgptSkillExportResult> {
  if (format !== 'markdown' && format !== 'zip') throw new Error('Unknown ChatGPT skill export format');
  const bytes = await readBundledChatgptSkill();
  const options = {
    title: 'Save ChatGPT skill',
    defaultPath: path.join(app.getPath('downloads'), format === 'zip' ? 'OneCode-ChatGPT-Skill.zip' : 'SKILL.md'),
    filters: [{ name: format === 'zip' ? 'Skill ZIP' : 'SKILL.md', extensions: [format === 'zip' ? 'zip' : 'md'] }]
  };
  const selected = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (selected.canceled || !selected.filePath) return { done: 'cancelled' };
  await fs.writeFile(selected.filePath, format === 'zip' ? zipSync({ [`${CHATGPT_WEB_SKILL_NAME}/SKILL.md`]: bytes }) : bytes);
  return { done: 'saved', name: path.basename(selected.filePath) };
}
