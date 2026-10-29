/** Public reusable guidance; installation and per-message authority remain separate. */
export const CLAUDE_WEB_SKILL_NAME = 'onecode';
export const CLAUDE_WEB_SKILL_VERSION = 'ONECODE-SKILL-1';
export const CLAUDE_SKILLS_URL = 'https://claude.ai/customize/skills';
export type ClaudeSkillExportFormat = 'markdown' | 'zip';
export type ClaudeSkillExportResult = { done: 'cancelled' } | { done: 'saved'; name: string };
