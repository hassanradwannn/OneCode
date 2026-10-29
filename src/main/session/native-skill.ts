import { readBundledClaudeSkill } from '../claude-web-skill.js';
import { getConfig } from '../config.js';
import type { ChatProvider } from '../../shared/chat-provider.js';
import { MAX_BROWSER_MESSAGE_CHARS, prependUserPrompt, userPromptText } from '../../shared/user-prompt.js';

/** Alternatives supplied by the same task owner, never caller-authored replacement text. */
export interface NativeSkillDelivery {
  name: 'onecode';
  text: string;
  fallbackText: string;
}
export async function optionalNativeSkillGuidance(provider: ChatProvider): Promise<string | null> {
  if (provider !== 'claude' || getConfig().mcp.useClaudeWebSkill !== true) return null;
  const body = (await readBundledClaudeSkill()).toString('utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/\r\n?/g, '\n').trim();
  return 'Complete OneCode guidance when the optional native skill is unavailable. Follow this guidance directly; do not claim that a native skill loaded.\n\n' + body;
}
/** Reserve fallback space before fitting project/selected-skill context, preserving one frozen snapshot. */
export function nativeSkillBudget(budget: { maxChars: number; maxBytes: number }, guidance: string | null) {
  if (!guidance) return budget;
  return { maxChars: budget.maxChars - guidance.length - 96, maxBytes: budget.maxBytes - Buffer.byteLength(guidance, 'utf8') - 96 };
}
export function nativeSkillDelivery(text: string, guidance: string | null,
  budget = { maxChars: MAX_BROWSER_MESSAGE_CHARS, maxBytes: 128000 }): { text: string; nativeSkill?: NativeSkillDelivery } {
  if (!guidance) return { text };
  text = text.replace(/\r\n?/g, '\n');
  // Keep every frozen instruction and the original authored tail. Only the public,
  // reusable manual differs; task credentials and caller authority are identical.
  const identity = /^\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\n\n/.exec(text)?.[0] ?? '';
  const header = /^\[\[COS_CONTEXT:(\d{1,6})\]\]\n/.exec(text.slice(identity.length));
  const start = identity.length + (header?.[0].length ?? 0);
  const context = header && userPromptText(text) !== null ? text.slice(start, start + Number(header[1])) : '';
  const fallbackText = prependUserPrompt(text, [context, guidance].filter(Boolean).join('\n\n'));
  if (userPromptText(fallbackText) !== (userPromptText(text) ?? text) || fallbackText.length > budget.maxChars ||
      Buffer.byteLength(fallbackText, 'utf8') > budget.maxBytes) throw new Error('The full native-skill fallback exceeds the delivery limit; shorten the request or selected instructions. Nothing was submitted.');
  return { text: fallbackText, nativeSkill: { name: 'onecode', text, fallbackText } };
}
