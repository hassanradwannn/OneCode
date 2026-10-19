/** Shared command labels; each surface explicitly chooses the actions it can perform. */
export const COMPOSER_COMMANDS = [
      { command: 'plan', name: 'Plan', description: 'Turn the next composer request into editable stages.', glyph: 'i-steps' },
      { command: 'goal', name: 'Goal', description: 'Pursue a saved objective and stop when it is complete.', glyph: 'i-target' },
      { command: 'loop', name: 'Loop', description: 'Keep continuing toward the saved objective.', glyph: 'i-loop' },
      { command: 'compact', name: 'Compact', description: 'Compact this chat and resume it in a fresh conversation.', glyph: 'i-copy' },
      // Codex's slash commands, each opening what the app already has.
      { command: 'model', name: 'Model', description: 'Choose the model for this chat.', glyph: 'i-sparkle' },
      { command: 'reasoning', name: 'Reasoning', description: 'Choose how long the model thinks.', glyph: 'i-bolt' },
      { command: 'new', name: 'New chat', description: 'Start a new chat.', glyph: 'i-plus' },
      { command: 'rename', name: 'Rename', description: 'Rename this chat in the app.', glyph: 'i-pencil' },
      { command: 'pin', name: 'Pin', description: 'Pin or unpin this chat at the top of its list.', glyph: 'i-pin' },
      { command: 'status', name: 'Status', description: 'Show how full this chat is.', glyph: 'i-pulse' },
      { command: 'review', name: 'Review', description: 'Ask for a review of the uncommitted changes.', glyph: 'i-git-diff' },
      { command: 'init', name: 'Init', description: 'Ask for an AGENTS.md that describes this project.', glyph: 'i-file-text' },
      { command: 'usage', name: 'Usage', description: 'Open usage and token statistics.', glyph: 'i-chart' },
      { command: 'plugins', name: 'Plugins', description: 'Open the plugins and their status.', glyph: 'i-plug' },
      { command: 'pet', name: 'Pet', description: 'Open the pets.', glyph: 'i-paw' },
      { command: 'feedback', name: 'Feedback', description: 'Open the diagnostics report to attach to a bug report.', glyph: 'i-warning' }
] as const;

/** Completion is limited to the leading command block and a collapsed caret. */
export function skillCompletion(text: string, start: number, end = start): { start: number; end: number; query: string } | null {
  if (start !== end || /\S/.test(text.slice(end).split(/\s/, 1)[0] ?? '')) return null;
  const before = text.slice(0, start);
  const match = /(?:^|\s)(\/(?:prompt(?:\s+[a-z0-9._-]*)?|[a-z0-9._-]*))$/i.exec(before);
  if (!match) return null;
  const at = start - match[1]!.length;
  const preceding = text.slice(0, at).trim();
  if (preceding && !/^(?:\/(?!prompt(?:\s|$))[a-z0-9._-]+|\/prompt\s+[a-z0-9._-]+)(?:\s+(?:\/(?!prompt(?:\s|$))[a-z0-9._-]+|\/prompt\s+[a-z0-9._-]+))*$/i.test(preceding)) return null;
  const token = match[1]!;
  return { start: at, end, query: token === '/prompt' ? '' : token.replace(/^\/prompt\s+|^\//, '').toLowerCase() };
}
