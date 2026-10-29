import type { AppApi } from '../preload/index.js';
import type { ChatBrowser } from '../shared/types.js';
import { CLAUDE_WEB_SKILL_NAME } from '../shared/claude-web-skill.js';
import { $, toast } from './dom.js';

/** This selected-provider setup exports guidance; only the user installs/enables it. */
export function initClaudeSkillSetup(api: Pick<AppApi, 'exportClaudeSkill' | 'openClaudeSkills'>): { apply(browser: ChatBrowser): void } {
  const markdown = $<HTMLButtonElement>('saveClaudeSkillMarkdown'), zip = $<HTMLButtonElement>('saveClaudeSkillZip');
  const open = $<HTMLButtonElement>('openClaudeSkills'), result = $('claudeSkillResult');
  let busy = false;
  const paint = () => { markdown.disabled = zip.disabled = open.disabled = busy; };
  const action = async (work: () => Promise<string | null>) => {
    if (busy) return; busy = true; paint();
    try { const message = await work(); if (message) result.textContent = message; }
    catch (error) { const message = error instanceof Error ? error.message : String(error); result.textContent = message; toast(message); }
    finally { busy = false; paint(); }
  };
  for (const [button, format] of [[markdown, 'markdown'], [zip, 'zip']] as const) button.addEventListener('click', () => void action(async () => {
    const reply = await api.exportClaudeSkill(format); if (!reply.ok) throw new Error(reply.error);
    return reply.data.done === 'saved' ? format === 'zip'
      ? `Saved ${reply.data.name}. Upload it in Claude's Skills page, then enable the skill.`
      : `Saved ${reply.data.name}. Use Save ZIP for the uploadable package, or ZIP this file inside a ${CLAUDE_WEB_SKILL_NAME} folder before uploading it.` : null;
  }));
  open.addEventListener('click', () => { void action(async () => {
    const reply = await api.openClaudeSkills(); if (!reply.ok || !reply.data) throw new Error(reply.ok ? 'Could not open the skills page.' : reply.error);
    return `In Customize → Skills, use + → Create skill → Upload a skill, select the ZIP, and enable ${CLAUDE_WEB_SKILL_NAME}. Keep this native skill name.`;
  }); });
  return { apply(_browser) { paint(); } };
}
