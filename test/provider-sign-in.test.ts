import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = source.slice(source.indexOf('async function askChatGptSignedIn('), source.indexOf('\n/**\n * The tabs a transfer'));

it.each([
  ['chatgpt.com', '<button data-testid="accounts-profile-button">Account</button><div id="prompt-textarea" contenteditable="true"></div>', true],
  ['chatgpt.com', '<button aria-label="Open profile menu">Account</button>', true],
  ['chat.openai.com', '<button data-testid="profile-button">Account</button>', true],
  ['chatgpt.com', '<a href="/auth/login">Log in</a><div id="prompt-textarea" contenteditable="true"></div>', false],
  ['chatgpt.com', '<div id="prompt-textarea" contenteditable="true"></div>', null],
  ['chatgpt.com', '<div style="display:none"><button data-testid="accounts-profile-button">Account</button></div>', null],
  ['chatgpt.com', '<button hidden data-testid="login-button">Log in</button><button data-testid="accounts-profile-button">Account</button>', true],
  ['chatgpt.com', '<button data-testid="login-button">Log in</button><button data-testid="accounts-profile-button">Account</button>', null],
  ['gemini.google.com', '<rich-textarea><div contenteditable="true" role="textbox"></div></rich-textarea>', true],
  ['gemini.google.com', '<button>Sign in</button>', false],
  ['example.com', '<button data-testid="accounts-profile-button">Account</button>', null]
])('reads rendered account evidence on %s: %s', async (host, html, expected) => {
  const page = new JSDOM(String(html), { url: `https://${host}/`, runScripts: 'outside-only' });
  try {
    const context: any = { browserReply: async (run: () => unknown) => run(), chrome: { scripting: {
      executeScript: async ({ func }: any) => [{ result: page.window.eval(`(${func.toString()})()`) }]
    } } };
    vm.createContext(context);
    vm.runInContext(code, context);
    expect(await context.askChatGptSignedIn(10)).toBe(expected);
  } finally { page.window.close(); }
});
