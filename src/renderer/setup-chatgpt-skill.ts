import type { AppApi } from '../preload/index.js';
import type { ChatBrowser } from '../shared/types.js';
import { $, toast } from './dom.js';

/** Export and remote activation remain separate explicit user actions. */
export function initChatgptSkillSetup(api: Pick<AppApi, 'exportChatgptSkill' | 'openChatgptSkills'>): { apply(browser: ChatBrowser): void } {
  const markdown = $<HTMLButtonElement>('saveChatgptSkillMarkdown');
  const zip = $<HTMLButtonElement>('saveChatgptSkillZip');
  const open = $<HTMLButtonElement>('openChatgptSkills');
  const result = $('chatgptSkillResult');
  let busy = false, embedded = false;
  const paint = () => { markdown.disabled = zip.disabled = busy; open.disabled = busy || embedded; };
  const action = async (work: () => Promise<string | null>) => {
    if (busy) return;
    busy = true; paint();
    try { const message = await work(); if (message) result.textContent = message; }
    catch (error) { const message = error instanceof Error ? error.message : String(error); result.textContent = message; toast(message); }
    finally { busy = false; paint(); }
  };
  for (const [button, format] of [[markdown, 'markdown'], [zip, 'zip']] as const) button.addEventListener('click', () => void action(async () => {
    const reply = await api.exportChatgptSkill(format);
    if (!reply.ok) throw new Error(reply.error);
    return reply.data.done === 'saved' ? `Saved ${reply.data.name}. Upload it in ChatGPT Skills and enable it before using the option below.` : null;
  }));
  open.addEventListener('click', () => { if (!embedded) void action(async () => {
    const reply = await api.openChatgptSkills();
    if (!reply.ok || !reply.data) throw new Error(reply.ok ? 'Could not open ChatGPT Skills.' : reply.error);
    return 'In ChatGPT, open Plugins → Skills, then Create → Upload from computer. Availability depends on your account and workspace.';
  }); });
  return { apply(browser) { embedded = browser === 'cos'; paint(); } };
}
