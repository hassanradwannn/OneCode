/** App-owned inert syntax spans, applied only after HTML sanitization. */
export function decorateJsonCode(code: HTMLElement): void {
  const value = code.textContent ?? '';
  if (value.length > 128_000) return;
  try { JSON.parse(value); } catch { return; }
  const document = code.ownerDocument, fragment = document.createDocumentFragment();
  const tokens = /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g;
  let at = 0;
  for (const token of value.matchAll(tokens)) {
    fragment.append(document.createTextNode(value.slice(at, token.index)));
    const span = document.createElement('span');
    span.className = token[1] ? 'json-key' : token[2] ? 'json-string' : token[3] ? 'json-literal' : 'json-number';
    span.textContent = token[0]; fragment.append(span); at = token.index + token[0].length;
  }
  fragment.append(document.createTextNode(value.slice(at)));
  code.replaceChildren(fragment);
}
