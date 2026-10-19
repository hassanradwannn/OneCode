import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react';
import { COMPOSER_COMMANDS, skillCompletion } from '../shared/composer-commands.js';
import { Icon } from './composer-controls.js';

export type RemoteSkill = { id: string; name: string; description: string };
const supported = new Set(['plan', 'goal', 'loop', 'model', 'reasoning', 'new', 'rename', 'review', 'init']);
export function useComposerCompletion(options: {
  draft: string; setDraft(value: string): void; input: RefObject<HTMLTextAreaElement | null>;
  skills: RemoteSkill[]; loading: boolean; sessionId: string | null; command(name: string): void;
}) {
  const [caret, setCaret] = useState<[number, number]>([0, 0]), [active, setActive] = useState(0), [dismissed, setDismissed] = useState<string | null>(null);
  const fragment = skillCompletion(options.draft, ...caret);
  const range = dismissed === options.draft ? null : fragment;
  const commands = range ? COMPOSER_COMMANDS.filter(row => supported.has(row.command) && row.command.includes(range.query)
    && (row.command !== 'rename' || options.sessionId)) : [];
  const skills = range ? options.skills.filter(skill => `${skill.id} ${skill.name} ${skill.description}`.toLowerCase().includes(range.query)).slice(0, 64) : [];
  const choices = [...commands.map(command => ({ id: command.command, label: command.name, description: command.description, command: true })),
    ...skills.map(skill => ({ id: skill.id, label: skill.name, description: skill.description, command: false }))];
  const index = Math.min(active, Math.max(0, choices.length - 1));
  useEffect(() => { setActive(0); }, [range?.query, options.sessionId]);
  useEffect(() => { if (range) document.getElementById(`composer-choice-${index}`)?.scrollIntoView({ block: 'nearest' }); }, [index, range?.query]);
  const select = (choice: typeof choices[number]) => {
    if (!range) return;
    const replacement = choice.command ? '' : `/${choice.id}\n`;
    const value = options.draft.slice(0, range.start) + replacement + options.draft.slice(range.end);
    options.setDraft(value); setDismissed(value);
    queueMicrotask(() => {
      const input = options.input.current; input?.focus({ preventScroll: true }); input?.setSelectionRange(range.start + replacement.length, range.start + replacement.length);
      if (choice.command) options.command(choice.id);
    });
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!range || event.nativeEvent.isComposing) return false;
    if (event.key === 'Escape') { event.preventDefault(); setDismissed(options.draft); return true; }
    if (!choices.length) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setActive((index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length); return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); select(choices[index]!); return true; }
    return false;
  };
  return { visible: !!range, keyDown, selectionChanged: () => { const input = options.input.current; if (input) setCaret([input.selectionStart, input.selectionEnd]); },
    menu: range && <div className="composer-completion" role="listbox" id="composer-completion" aria-label="Commands and skills">
      {!!commands.length && <div className="completion-heading">Commands</div>}
      {choices.map((choice, position) => <button type="button" role="option" id={`composer-choice-${position}`} key={`${choice.command}:${choice.id}`} aria-selected={position === index} onMouseDown={event => event.preventDefault()} onClick={() => select(choice)}>
        <Icon name={choice.command ? choice.id === 'plan' ? 'plan' : 'bolt' : 'skill'} /><span><strong>{choice.label}</strong><small>{choice.description}</small></span>
      </button>)}{options.loading && <p>Loading installed skills…</p>}{!choices.length && !options.loading && <p>No matching commands or skills</p>}
    </div>, activeId: range && choices.length ? `composer-choice-${index}` : undefined };
}
