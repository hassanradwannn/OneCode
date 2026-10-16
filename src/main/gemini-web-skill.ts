import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app, clipboard, dialog, type BrowserWindow } from 'electron';
import { zipSync } from 'fflate';
import { GEMINI_WEB_SKILL_NAME, GEMINI_WEB_SKILL_VERSION, type GeminiSkillExportFormat, type GeminiSkillExportResult } from '../shared/gemini-web-skill.js';

/** Only the bundled public asset is exportable; callers never supply its contents or path. */
export async function readBundledGeminiSkill(): Promise<{ bytes: Buffer; instructions: string }> {
  const root = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
  const file = path.join(root, 'skills', GEMINI_WEB_SKILL_NAME, 'SKILL.md');
  let bytes: Buffer;
  try { bytes = await fs.readFile(file); }
  catch { throw new Error('The bundled Gemini skill could not be read. Reinstall OneCode.'); }
  if (bytes.length > 64 * 1024) throw new Error('The bundled Gemini skill is invalid. Reinstall OneCode.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('The bundled Gemini skill is invalid. Reinstall OneCode.'); }
  const metadata = /^---\r?\nname: gemini-code\r?\ndescription: [^\r\n]+\r?\n---\r?\n/.exec(text);
  if (!metadata || text.includes('\0') || !text.includes(GEMINI_WEB_SKILL_VERSION))
    throw new Error('The bundled Gemini skill is invalid. Reinstall OneCode.');
  return { bytes, instructions: text.slice(metadata[0].length).trim() + '\n' };
}

export async function copyBundledGeminiSkill(): Promise<boolean> {
  const { instructions } = await readBundledGeminiSkill();
  await clipboard.writeText(instructions);
  return true;
}

export async function exportBundledGeminiSkill(format: GeminiSkillExportFormat, owner: BrowserWindow | null): Promise<GeminiSkillExportResult> {
  if (format !== 'markdown' && format !== 'zip') throw new Error('Unknown Gemini skill export format');
  const { bytes } = await readBundledGeminiSkill();
  const options = {
    title: 'Save Gemini skill',
    defaultPath: path.join(app.getPath('downloads'), format === 'zip' ? 'OneCode-Gemini-Skill.zip' : 'SKILL.md'),
    filters: [{ name: format === 'zip' ? 'Skill ZIP' : 'SKILL.md', extensions: [format === 'zip' ? 'zip' : 'md'] }]
  };
  const selected = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (selected.canceled || !selected.filePath) return { done: 'cancelled' };
  // The archive root follows Gemini's native upload contract, without a parent
  // directory, scripts, application settings, connector URLs or credentials.
  const output = format === 'zip' ? zipSync({ 'SKILL.md': bytes }) : bytes;
  await fs.writeFile(selected.filePath, output);
  return { done: 'saved', name: path.basename(selected.filePath) };
}
