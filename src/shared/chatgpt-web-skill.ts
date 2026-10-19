/** Public reusable guidance; exporting it grants no tool access. */
export const CHATGPT_WEB_SKILL_NAME = 'onecode-chatgpt';
export const CHATGPT_WEB_SKILL_VERSION = 'ONECODE-CHATGPT-SKILL-3';
export const CHATGPT_SKILLS_URL = 'https://help.openai.com/en/articles/20001066-skills-in-chatgpt';
export type ChatgptSkillExportFormat = 'markdown' | 'zip';
export type ChatgptSkillExportResult = { done: 'cancelled' } | { done: 'saved'; name: string };
