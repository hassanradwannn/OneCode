import { providerText } from './provider-text.js';
import type { AppApi } from '../preload/index.js';
import type { ChatBrowser } from '../shared/types.js';
import { $, toast } from './dom.js';
import { t } from './i18n.js';

type SkillSetupApi = Pick<AppApi, 'exportGeminiSkill' | 'copyGeminiSkillInstructions' | 'openGeminiSkills'>;

/** Exporting public guidance is separate from remote installation and connector readiness. */
export function initGeminiSkillSetup(api: SkillSetupApi): { apply(browser: ChatBrowser): void } {
  const markdown = $<HTMLButtonElement>('saveGeminiSkillMarkdown');
  const archive = $<HTMLButtonElement>('saveGeminiSkillZip');
  const copy = $<HTMLButtonElement>('copyGeminiSkillInstructions');
  const open = $<HTMLButtonElement>('openGeminiSkills');
  const result = $('geminiSkillResult');
  let busy = false, embedded = false;
  const paint = () => {
    for (const button of [markdown, archive, copy]) button.disabled = busy;
    open.disabled = busy || embedded;
    $('geminiSkillBrowserHelp').hidden = !embedded;
  };
  const action = async (work: () => Promise<string | null>) => {
    if (busy) return;
    busy = true; paint();
    try {
      const message = await work();
      if (message) result.textContent = message;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.textContent = message;
      toast(message);
    } finally { busy = false; paint(); }
  };
  for (const [button, format] of [[markdown, 'markdown'], [archive, 'zip']] as const) {
    button.addEventListener('click', () => void action(async () => {
      const reply = await api.exportGeminiSkill(format);
      if (!reply.ok) throw new Error(t(reply.error));
      const saved = reply.data;
      return saved.done === 'saved' ? `${t('Saved')} ${saved.name}. ${providerText('Upload it in Gemini Skills, then review and create the skill.')}` : null;
    }));
  }
  copy.addEventListener('click', () => void action(async () => {
    const reply = await api.copyGeminiSkillInstructions();
    if (!reply.ok) throw new Error(t(reply.error));
    if (!reply.data) throw new Error(t('Could not copy skill instructions.'));
    return providerText('Instructions copied. Create a skill named gemini-code in Gemini and paste them into its Instructions field.');
  }));
  open.addEventListener('click', () => {
    if (embedded) return;
    void action(async () => {
      const reply = await api.openGeminiSkills();
      if (!reply.ok) throw new Error(t(reply.error));
      if (!reply.data) throw new Error(providerText('Could not open Gemini Skills.'));
      return providerText('Gemini Skills opened in your selected browser. Check the Google account before importing.');
    });
  });
  return { apply(browser) { embedded = browser === 'cos'; paint(); } };
}
