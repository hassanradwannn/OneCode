import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';
import { connectorNames } from '../src/shared/connector-names.js';

const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const sanitize = vm.runInNewContext(background.slice(background.indexOf('function cleanOwnCoreApp('),
  background.indexOf('async function rememberOwnCoreApp(')) + '\n({cleanConnectorNames,cleanOwnCoreApp})');
function adapter(file: string) {
  const context = vm.createContext({URL, document: {querySelector: () => null, querySelectorAll: () => []},
    location: {pathname: '/', href: 'https://chatgpt.com/'}, window: {}});
  vm.runInContext(readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8'), context);
  return (context as any).CLF_DOM ?? (context as any).window.CLF_DOM;
}

it.each(['chatgpt-dom.js','gemini-dom.js'].flatMap(file => ['', 'Desktop', 'Windows VM', 'لابتوب'].map(suffix => [file,suffix])))('preserves generated device names across the companion and %s adapter: %s', (file,suffix) => {
  const names = connectorNames(suffix);
  const accepted = sanitize.cleanConnectorNames(names);
  expect(accepted).toEqual(names);
  const remembered = {appId: 'asdk_app_chatgpt_desktop', name: names.core};
  expect(sanitize.cleanOwnCoreApp(remembered)).toEqual(remembered);
  const dom = adapter(file);
  expect(dom.setConnectorNames(accepted)).toBe(true);
  expect(dom.connectorNames()).toEqual(Object.values(names));
});

it('retains legacy parenthesized device names but refuses a different surface or invalid suffix', () => {
  const names = {core:'OneCode Core (Desktop)',desktop:'OneCode Desktop (Desktop)',plugins:'OneCode Plugins (Desktop)'};
  expect(sanitize.cleanConnectorNames(names)).toEqual(names);
  expect(adapter('chatgpt-dom.js').setConnectorNames(names)).toBe(true);
  for (const core of ['OneCode Backup','OneCode Desktop Desktop','OneCode Core Win/VM','OneCode Core ' + 'x'.repeat(33)]) {
    expect(sanitize.cleanConnectorNames({...names,core})).toBeNull();
    expect(adapter('chatgpt-dom.js').setConnectorNames({...names,core})).toBe(false);
  }
});
