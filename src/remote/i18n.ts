/** Remote's existing English presentation; shared transcript helpers use this small facade. */
export function currentLanguage(): 'en' { return 'en'; }
export function t(source: string, args: readonly unknown[] = []): string {
  return source.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < args.length ? String(args[Number(index)]) : match);
}
export function ui<T extends Node>(node: T, property: 'textContent' | 'title' | 'placeholder' | 'aria-label' | 'aria-valuetext' | 'data-usage-hint', value: () => string): T {
  if (property === 'textContent') node.textContent = value();
  else (node as unknown as Element).setAttribute(property, value());
  return node;
}
export function uiText(value: () => string): Text { return document.createTextNode(value()); }
export function onLanguageChange(_listener: () => void): () => void { return () => undefined; }
