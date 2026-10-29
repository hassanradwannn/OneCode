/** Preserve semantic formatting from rendered provider responses; never replay HTML. */
var CLF_GEMINI_MARKDOWN = (() => {
  let serial = 0;
  const omit = 'button,script,style,svg,action-card,remy-confirmation-card,[hidden],[aria-hidden="true"]';
  const escape = value => value.replace(/([\\`*_[\]<>])/g, '\\$1');
  function render(root) {
    if (!root) return '';
    let prefix;
    do { prefix = `\uE000GC_CODE_${++serial}_`; } while ((root.textContent || '').includes(prefix));
    const blocks = [];
    const keepBlock = value => { const token = `${prefix}${blocks.length}\uE001`; blocks.push([token, value]); return `\n\n${token}\n\n`; };
    const children = node => [...node.childNodes].map(read).join('');
    const code = node => {
      const body = node.matches('pre') ? node.querySelector('code') || node :
        node.querySelector('[data-test-id="code-content"],pre code,pre');
      if (!body) return children(node);
      const value = (body.textContent || '').replace(/\r\n?/g, '\n');
      const hinted = body.className?.match(/(?:^|\s)language-([\w#+.-]+)/)?.[1] ||
        node.querySelector('.code-block-decoration > span')?.textContent?.trim() || '';
      const language = /^[\w#+.-]{1,32}$/.test(hinted) ? hinted.toLowerCase() : '';
      const longest = Math.max(2, ...[...value.matchAll(/`+/g)].map(match => match[0].length));
      const fence = '`'.repeat(longest + 1);
      return keepBlock(`${fence}${language}\n${value}${value.endsWith('\n') ? '' : '\n'}${fence}`);
    };
    function read(node) {
      if (node.nodeType === 3) return escape((node.textContent || '').replace(/\s+/g, ' '));
      if (node.nodeType !== 1) return '';
      if (node.matches(omit) || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(node.getAttribute('style') || '')) return '';
      const tag = node.localName;
      // MathML's explicit TeX annotation is source, while the accompanying
      // typeset HTML repeats its visual text. Preserve source once for the
      // existing trusted=false math renderer instead of flattening both copies.
      if (tag === 'math' || node.matches('.katex,.katex-display')) {
        const annotations = [...node.querySelectorAll('annotation[encoding="application/x-tex"]')];
        const tex = annotations.length === 1 ? annotations[0].textContent : null;
        if (tex && tex.length <= 50000) {
          const display = node.matches('.katex-display') || node.closest('.katex-display') || node.getAttribute('display') === 'block';
          return display ? keepBlock(`\\[\n${tex}\n\\]`) : `\\(${tex}\\)`;
        }
      }
      if (tag === 'code-block' || tag === 'pre') return code(node);
      if (tag === 'code') {
        const value = node.textContent || '', runs = [...value.matchAll(/`+/g)].map(match => match[0].length);
        const fence = '`'.repeat(Math.max(0, ...runs) + 1), pad = /^\s|\s$|^`|`$/.test(value) ? ' ' : '';
        return `${fence}${pad}${value}${pad}${fence}`;
      }
      if (tag === 'br') return '\n';
      if (tag === 'hr') return '\n\n---\n\n';
      if (tag === 'img') return escape(node.getAttribute('alt') || '');
      if (tag === 'a') {
        const label = children(node), href = node.getAttribute('href') || '';
        return /^(?:https?:|mailto:|#)/i.test(href)
          ? `[${label}](${href.replace(/[\s()<>\\]/g, char => char === '(' ? '%28' : char === ')' ? '%29' : encodeURIComponent(char))})` : label;
      }
      if (tag === 'strong' || tag === 'b') return `**${children(node)}**`;
      if (tag === 'em' || tag === 'i') return `*${children(node)}*`;
      if (tag === 'del' || tag === 's') return `~~${children(node)}~~`;
      if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${children(node).trim()}\n\n`;
      if (tag === 'ul' || tag === 'ol') {
        const start = Number.parseInt(node.getAttribute('start') || '1', 10) || 1;
        return '\n\n' + [...node.children].filter(child => child.localName === 'li').map((item, index) => {
          const marker = tag === 'ol' ? `${start + index}. ` : '- ';
          return marker + children(item).trim().replace(/\n/g, '\n' + ' '.repeat(marker.length));
        }).join('\n') + '\n\n';
      }
      if (tag === 'blockquote') return '\n\n' + children(node).trim().split('\n').map(line => '> ' + line).join('\n') + '\n\n';
      if (tag === 'table') {
        const rows = [...node.querySelectorAll('tr')].filter(row => row.closest('table') === node).map(row =>
          [...row.children].filter(cell => /^(th|td)$/.test(cell.localName)).map(cell => children(cell).trim().replace(/\n+/g, ' ').replace(/\|/g, '\\|')));
        if (!rows.length) return '';
        const width = Math.max(...rows.map(row => row.length));
        const line = row => '| ' + Array.from({ length: width }, (_, index) => row[index] || '').join(' | ') + ' |';
        return '\n\n' + [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n') + '\n\n';
      }
      const content = children(node);
      return /^(p|div|section|article)$/.test(tag) ? `\n\n${content.trim()}\n\n` : content;
    }
    let result = read(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    for (const [token, value] of blocks) result = result.split(token).join(value);
    return result;
  }
  return { render };
})();
