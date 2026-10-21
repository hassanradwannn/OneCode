/** Public native Gemini guidance, separate from local imported Skills and credentials. */
export const GEMINI_WEB_SKILL_NAME = 'onecode-gemini';
export const GEMINI_WEB_SKILL_VERSION = 'ONECODE-GEMINI-SKILL-3';
export const GEMINI_SKILLS_URL = 'https://gemini.google.com/customize/skills';
export type GeminiSkillExportFormat = 'markdown' | 'zip';
export type GeminiSkillExportResult = { done: 'cancelled' } | { done: 'saved'; name: string };
