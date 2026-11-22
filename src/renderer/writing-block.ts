import { Marked, type TokenizerAndRendererExtension } from 'marked';

export interface WritingSlot { label: string; source: string; complete: boolean }
export function writingBlock(slots: WritingSlot[]): TokenizerAndRendererExtension {
  return {
    name: 'writingBlock', level: 'block',
    start: value => value.match(/^:::writing\b/m)?.index,
    tokenizer(value) {
      // Without its closing `:::` the block runs to the end of the message, as Gemini draws it:
      // the block is still streaming, or the answer was stopped inside it.
      const match = /^:::writing(\{[^}\n]*\})?[ \t]*\n/.exec(value);
      if (!match) return undefined;
      const attribute = (name: string): string => match[1]?.match(new RegExp(`\\b${name}="([^"\\n]*)"`))?.[1] ?? '';
      const body = value.slice(match[0].length);
      let fence = '', close: RegExpExecArray | undefined;
      for (const marker of body.matchAll(/^( {0,3}(?:`{3,}|~{3,})[^\n]*|:::[ \t]*)(?:\n|$)/gm)) {
        if (marker[1]!.startsWith(':::')) {
          if (!fence) { close = marker; break; }
          continue;
        }
        const run = /^(?:`+|~+)/.exec(marker[1]!.trimStart())?.[0];
        if (!run) continue;
        if (!fence) fence = run;
        else if (run[0] === fence[0] && run.length >= fence.length && marker[1]!.trim() === run) fence = '';
      }
      const source = close ? body.slice(0, close.index).replace(/\n$/, '') : body;
      const raw = close ? value.slice(0, match[0].length + close.index + close[0].length) : value;
      const slot = slots.push({ label: attribute('title') || attribute('subject'), source, complete: !!close }) - 1;
      return { type: 'writingBlock', raw, slot, tokens: this.lexer.blockTokens(source, []) };
    },
    renderer(token) {
      return `<blockquote><p>\uE010${Number(token['slot'])}\uE011</p>${this.parser.parse(token.tokens ?? [])}</blockquote>`;
    }
  };
}

export function capturedWritingBlocks(source: string): WritingSlot[] {
  const slots: WritingSlot[] = [];
  if (source.includes(':::writing')) new Marked({ extensions: [writingBlock(slots)] }).lexer(source);
  return slots.filter(slot => slot.complete && slot.source.trim());
}
